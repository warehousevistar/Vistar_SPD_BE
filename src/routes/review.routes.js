import { Router } from 'express';
import { all, get, tx } from '../db/index.js';
import { requireAuth, canRead, canSupervise } from '../middleware/auth.js';
import { wrap, badRequest, conflict, notFound } from '../middleware/error.js';
import { shiftStats, tableStats, memberStats } from '../lib/compute.js';
import { audit } from '../lib/audit.js';

export const reviewRoutes = Router();
reviewRoutes.use(requireAuth);

const nf = (n) => Number(n).toLocaleString('en-IN');

/**
 * UC-07 / FR-9.1 — everything the Supervisor needs on one screen: the headline
 * reconciliation, every flagged exception, and the table- and member-wise
 * status.
 *
 * `canFinalise` is computed here rather than in the client so the button's
 * enabled state and the server's own refusal cannot disagree.
 */
reviewRoutes.get('/review', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const shift = await get(
    `SELECT s.*, u.name AS final_by_name FROM shifts s LEFT JOIN users u ON u.id = s.final_by WHERE s.id = $1`,
    [shiftId],
  );
  if (!shift) throw notFound('No such shift');

  const stats = await shiftStats(shiftId);
  const exceptions = await all(
    `SELECT e.*, l.part_no, l.invoice_no, l.grn_qty, l.uom, u.name AS resolved_by_name
       FROM exceptions e
       JOIN grn_lines l ON l.id = e.line_id
       LEFT JOIN users u ON u.id = e.resolved_by
      WHERE l.shift_id = $1
      ORDER BY e.created_at DESC`,
    [shiftId],
  );

  // BR-03 — every exception must carry a remark (or be resolved) first.
  const canFinalise = shift.status !== 'Finalised' && exceptions.every((e) => e.remarks || e.resolved_at);

  res.json({
    shift,
    stats,
    exceptions,
    tables: await tableStats(shiftId),
    members: await memberStats(shiftId),
    canFinalise,
    blockers: exceptions.filter((e) => !e.remarks && !e.resolved_at).map((e) => e.id),
  });
}));

/** FR-9.2 — the Supervisor annotates an exception, and may close it. */
reviewRoutes.patch('/exceptions/:id', canSupervise, wrap(async (req, res) => {
  const remarks = String(req.body?.remarks || '').trim();
  const resolve = Boolean(req.body?.resolve);
  if (!remarks) throw badRequest('An exception cannot be saved without supervisor remarks (FR-9.2)');

  const out = await tx(async (q) => {
    const [e] = await q('SELECT * FROM exceptions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!e) throw notFound('No such exception');
    if (e.resolved_at) throw conflict(`${e.id} was already resolved — reopen it only through a new exception`);

    const [row] = await q(
      `UPDATE exceptions
          SET remarks = $2, resolved_by = CASE WHEN $3 THEN $4 ELSE resolved_by END,
              resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END
        WHERE id = $1 RETURNING *`,
      [e.id, remarks, resolve, req.user.id],
    );
    await audit({
      actorId: req.user.id,
      action: resolve ? 'Exception Resolved' : 'Exception Remark',
      reference: e.id, detail: remarks,
      before: 'Open', after: resolve ? 'Resolved' : 'Open (annotated)',
    }, q);
    return row;
  });

  res.json({ exception: out });
}));

/**
 * UC-07 / FR-9.3 / FR-10.1 / BR-06 — verify and submit the final status.
 *
 * Locking the shift and writing the MIS snapshot happen in the same
 * transaction: a shift that is locked without its MIS, or an MIS generated for
 * a shift that stayed open, are both worse than the operation failing.
 */
reviewRoutes.post('/shifts/:id/finalise', canSupervise, wrap(async (req, res) => {
  const shiftId = req.params.id;
  const stats = await shiftStats(shiftId);

  const out = await tx(async (q) => {
    const [shift] = await q('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [shiftId]);
    if (!shift) throw notFound('No such shift');
    if (shift.status === 'Finalised') throw conflict(`${shift.label} is already finalised`);

    const open = await q(
      `SELECT e.id FROM exceptions e JOIN grn_lines l ON l.id = e.line_id
        WHERE l.shift_id = $1 AND e.resolved_at IS NULL AND e.remarks = ''`,
      [shiftId],
    );
    if (open.length) {
      throw conflict(
        `${open.length} exception${open.length === 1 ? '' : 's'} still need supervisor remarks before the shift can be submitted (BR-03): ${open.map((e) => e.id).join(', ')}`,
      );
    }

    await q(`UPDATE shifts SET status = 'Finalised', final_by = $2, final_at = now() WHERE id = $1`, [shiftId, req.user.id]);

    // shift_date is a 'YYYY-MM-DD' string (see the DATE parser in db/index.js),
    // so MIS-0909 is the ninth of September and not the day before it.
    const misId = `MIS-${String(shift.shift_date).slice(5).replace(/-/g, '')}${shift.resubmits ? `-R${shift.resubmits + 1}` : ''}`;
    await q(
      `INSERT INTO mis_snapshots (id, shift_id, generated_at, lines_packed, pouches, boxes, packed_qty, pending_qty, provisional)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, FALSE)
       ON CONFLICT (id) DO UPDATE SET generated_at = now(), lines_packed = EXCLUDED.lines_packed,
         pouches = EXCLUDED.pouches, boxes = EXCLUDED.boxes, packed_qty = EXCLUDED.packed_qty,
         pending_qty = EXCLUDED.pending_qty, provisional = FALSE`,
      [misId, shiftId, stats.linesPacked, stats.pouches, stats.boxes, stats.packed, stats.pending],
    );

    await audit({
      actorId: req.user.id,
      action: shift.resubmits > 0 ? 'Resubmission' : 'Final Submission',
      reference: shiftId,
      detail: `Shift verified & submitted — member entry locked, MIS ${misId} generated automatically (FR-10.1) · packed ${nf(stats.packed)} / GRN ${nf(stats.grn)} · pending ${nf(stats.pending)}`,
      before: 'Open',
      after: shift.resubmits > 0 ? `Finalised (rev ${shift.resubmits + 1})` : 'Finalised',
    }, q);

    return { misId, stats };
  });

  res.json(out);
}));

/** BR-06 — reopening is the Supervisor's alone and is logged as a resubmission. */
reviewRoutes.post('/shifts/:id/reopen', canSupervise, wrap(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw badRequest('Reopening must be logged with a reason (BR-06)');

  const out = await tx(async (q) => {
    const [shift] = await q('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!shift) throw notFound('No such shift');
    if (shift.status !== 'Finalised') throw conflict(`${shift.label} is already open`);

    const [row] = await q(
      `UPDATE shifts SET status = 'Open', resubmits = resubmits + 1 WHERE id = $1 RETURNING *`,
      [shift.id],
    );
    await audit({
      actorId: req.user.id, action: 'Resubmission', reference: shift.id,
      detail: `Shift reopened — ${reason}`,
      before: 'Finalised', after: `Open (rev ${row.resubmits + 1})`,
    }, q);
    return row;
  });

  res.json({ shift: out });
}));
