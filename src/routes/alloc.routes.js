import { Router } from 'express';
import { all, get, tx } from '../db/index.js';
import { requireAuth, canRead, canSupervise } from '../middleware/auth.js';
import { wrap, badRequest, conflict, notFound } from '../middleware/error.js';
import { tableStats } from '../lib/compute.js';
import { nextId } from '../lib/ids.js';
import { audit } from '../lib/audit.js';

export const allocRoutes = Router();
allocRoutes.use(requireAuth);

const nf = (n) => Number(n).toLocaleString('en-IN');

/** FR-4.3 — the live table status board. */
allocRoutes.get('/tables', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const tables = await tableStats(shiftId);
  const lines = await all(
    `SELECT a.table_no, l.id, l.part_no, l.part_desc, l.invoice_no, l.grn_qty, l.uom, a.qty AS alloc_qty,
            COALESCE(p.packed, 0) AS packed
       FROM allocations a
       JOIN grn_lines l ON l.id = a.line_id
       LEFT JOIN (SELECT line_id, SUM(qty) AS packed FROM packing_txns WHERE status <> 'Started' GROUP BY line_id) p
              ON p.line_id = l.id
      WHERE l.shift_id = $1
      ORDER BY a.table_no, l.invoice_no, l.part_no`,
    [shiftId],
  );
  const byTable = {};
  for (const l of lines) {
    (byTable[l.table_no] ??= []).push({ ...l, pending: Number(l.grn_qty) - Number(l.packed) });
  }
  res.json({ tables: tables.map((t) => ({ ...t, lines: byTable[t.table_no] ?? [] })) });
}));

allocRoutes.get('/allocations', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const rows = await all(
    `SELECT a.*, l.part_no, l.invoice_no, l.grn_qty, l.uom, u.name AS allocated_by_name
       FROM allocations a
       JOIN grn_lines l ON l.id = a.line_id
       LEFT JOIN users u ON u.id = a.allocated_by
      WHERE l.shift_id = $1
      ORDER BY a.allocated_at DESC`,
    [shiftId],
  );
  res.json({ allocations: rows });
}));

/**
 * UC-03 / FR-4.1 / BR-04.
 *
 * Two shapes in one call, matching the Supervisor's allocation dialog: either
 * the whole line goes to one table (`tableNo`), or it is split between two
 * (`splitWith` + `qty1`/`qty2` + a mandatory reason). BR-04 is the rule that a
 * line cannot sit on two tables *by accident* — the split is allowed precisely
 * because it is explicit and reasoned.
 */
allocRoutes.post('/allocations', canSupervise, wrap(async (req, res) => {
  const { lineId, tableNo, splitWith, qty1, qty2, reason } = req.body ?? {};
  if (!lineId || !tableNo) throw badRequest('Choose a GRN line and a packing table');

  const out = await tx(async (q) => {
    const [line] = await q(
      `SELECT l.*, s.status AS shift_status, s.label AS shift_label
         FROM grn_lines l JOIN shifts s ON s.id = l.shift_id
        WHERE l.id = $1 FOR UPDATE OF l`,
      [lineId],
    );
    if (!line) throw notFound('No such GRN line');
    if (line.shift_status === 'Finalised') {
      throw conflict(`${line.shift_label} is finalised — reopen the shift to change allocations (BR-06)`);
    }

    const existing = await q('SELECT * FROM allocations WHERE line_id = $1', [lineId]);
    const grn = Number(line.grn_qty);

    if (splitWith) {
      if (splitWith === tableNo) throw badRequest('Pick two different tables for a split');
      const r = String(reason || '').trim();
      if (!r) throw badRequest('A split allocation must record a reason (BR-04)');
      const a = Number(qty1);
      const b = Number(qty2);
      if (!(a > 0 && b > 0)) throw badRequest('Both split quantities must be greater than zero');
      if (a + b !== grn) throw badRequest(`Split quantities must total the GRN quantity of ${nf(grn)} — ${nf(a)} + ${nf(b)} is ${nf(a + b)}`);
      if (existing.length) throw conflict(`${line.part_no} is already allocated to ${existing.map((e) => e.table_no).join(', ')}`);

      const id1 = await nextId('allocations', 'AL', 3, q);
      await q(
        `INSERT INTO allocations (id, line_id, table_no, qty, reason, allocated_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id1, lineId, tableNo, a, r, req.user.id],
      );
      const id2 = await nextId('allocations', 'AL', 3, q);
      await q(
        `INSERT INTO allocations (id, line_id, table_no, qty, reason, allocated_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id2, lineId, splitWith, b, r, req.user.id],
      );
      await audit({
        actorId: req.user.id, action: 'Table Allocation (Split)', reference: line.part_no,
        detail: `${tableNo} (${nf(a)}) + ${splitWith} (${nf(b)}) — ${r}`,
        before: 'Unallocated', after: `${tableNo}+${splitWith}`,
      }, q);
      return { tables: [tableNo, splitWith], split: true };
    }

    // BR-04 — a second table without an explicit split is refused.
    if (existing.length) {
      throw conflict(
        `${line.part_no} is already allocated to ${existing.map((e) => e.table_no).join(', ')} — a line cannot sit on two tables unless the quantity is explicitly split with a reason (BR-04)`,
      );
    }

    const id = await nextId('allocations', 'AL', 3, q);
    await q(
      `INSERT INTO allocations (id, line_id, table_no, qty, reason, allocated_by) VALUES ($1, $2, $3, NULL, '', $4)`,
      [id, lineId, tableNo, req.user.id],
    );
    await audit({
      actorId: req.user.id, action: 'Table Allocation', reference: line.part_no,
      detail: `${line.invoice_no} → ${tableNo}`, before: 'Unallocated', after: tableNo,
    }, q);
    return { tables: [tableNo], split: false };
  });

  res.status(201).json(out);
}));

/** Withdrawing an allocation is only possible before anything was packed against it. */
allocRoutes.delete('/allocations/:id', canSupervise, wrap(async (req, res) => {
  const out = await tx(async (q) => {
    const [a] = await q(
      `SELECT a.*, l.part_no, l.invoice_no, s.status AS shift_status
         FROM allocations a JOIN grn_lines l ON l.id = a.line_id JOIN shifts s ON s.id = l.shift_id
        WHERE a.id = $1`,
      [req.params.id],
    );
    if (!a) throw notFound('No such allocation');
    if (a.shift_status === 'Finalised') throw conflict('The shift is finalised — reopen it to change allocations (BR-06)');
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM packing_txns WHERE line_id = $1 AND table_no = $2`,
      [a.line_id, a.table_no],
    );
    if (n > 0) throw conflict(`${a.table_no} has already packed against ${a.part_no} — the allocation stays for the audit trail`);
    await q('DELETE FROM allocations WHERE id = $1', [req.params.id]);
    await audit({
      actorId: req.user.id, action: 'Allocation Withdrawn', reference: a.part_no,
      detail: `${a.invoice_no} withdrawn from ${a.table_no} before any packing`, before: a.table_no, after: 'Unallocated',
    }, q);
    return { ok: true };
  });
  res.json(out);
}));

/* ------------------------------------------------ FR-13.2 table master ---- */

allocRoutes.post('/tables', canSupervise, wrap(async (req, res) => {
  const { tableNo, memberId, sortOrder } = req.body ?? {};
  if (!tableNo) throw badRequest('A table needs a number');
  const existing = await get('SELECT table_no FROM packing_tables WHERE table_no = $1', [tableNo]);
  if (existing) throw conflict(`${tableNo} already exists`);
  await tx(async (q) => {
    await q('INSERT INTO packing_tables (table_no, member_id, sort_order) VALUES ($1, $2, $3)',
      [tableNo, memberId || null, Number(sortOrder) || 0]);
    await audit({
      actorId: req.user.id, action: 'Config Change', reference: 'Table Master',
      detail: `Table ${tableNo} added${memberId ? ` · assigned to ${memberId}` : ''}`, before: '—', after: 'Created',
    }, q);
  });
  res.status(201).json({ ok: true });
}));

allocRoutes.patch('/tables/:tableNo', canSupervise, wrap(async (req, res) => {
  const t = await get('SELECT * FROM packing_tables WHERE table_no = $1', [req.params.tableNo]);
  if (!t) throw notFound('No such packing table');
  const memberId = req.body?.memberId === undefined ? t.member_id : (req.body.memberId || null);
  const active = req.body?.active === undefined ? t.active : Boolean(req.body.active);

  if (memberId && memberId !== t.member_id) {
    const clash = await get('SELECT table_no FROM packing_tables WHERE member_id = $1 AND table_no <> $2', [memberId, t.table_no]);
    if (clash) throw conflict(`That member is already assigned to ${clash.table_no}`);
  }

  await tx(async (q) => {
    await q('UPDATE packing_tables SET member_id = $2, active = $3 WHERE table_no = $1', [t.table_no, memberId, active]);
    await audit({
      actorId: req.user.id, action: 'Config Change', reference: 'Table Master',
      detail: `${t.table_no} · member ${memberId || 'unstaffed'} · ${active ? 'active' : 'inactive'}`,
      before: `${t.member_id || 'unstaffed'} · ${t.active ? 'active' : 'inactive'}`, after: 'Saved',
    }, q);
  });
  res.json({ ok: true });
}));
