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
 * UC-03 / FR-4.1 / BR-04 — putting a line on one table, or on several.
 *
 * A line goes to as many tables as the work needs, and a table takes as many
 * lines: an invoice of four parts can be spread over three tables and a table
 * can be working parts from three invoices, which is what the floor does. The
 * rule BR-04 actually protects is not *one table per line* — it is that a line
 * never lands on a second table by accident. So the first table is a plain
 * choice, and every table after it has to say why.
 *
 * Two shapes, because the dialog offers two: `{ tableNo }` sends the whole
 * line to one table, and `{ tables: [{ tableNo, qty }, …], reason }` sends it
 * to several at once, atomically, so a split cannot half-happen.
 *
 * `qty` is optional throughout, and NULL keeps its old meaning: *this table
 * works this line, quantity unstated*. Several tables may hold NULL — that is
 * a shared queue, and what each one actually did comes back in its packing
 * transactions. Where quantities are stated they are shares of the line, so
 * they may total less than the GRN quantity (the rest being unstated) but
 * never more.
 */
allocRoutes.post('/allocations', canSupervise, wrap(async (req, res) => {
  const { lineId, reason } = req.body ?? {};
  const wanted = Array.isArray(req.body?.tables) && req.body.tables.length
    ? req.body.tables.map((t) => (typeof t === 'string' ? { tableNo: t } : t ?? {}))
    : (req.body?.tableNo ? [{ tableNo: req.body.tableNo, qty: req.body.qty }] : []);

  if (!lineId || !wanted.length) throw badRequest('Choose a GRN line and at least one packing table');
  if (wanted.some((t) => !t.tableNo)) throw badRequest('Every allocation needs a table');

  const dupes = wanted.map((t) => t.tableNo).filter((t, i, a) => a.indexOf(t) !== i);
  if (dupes.length) throw badRequest(`${[...new Set(dupes)].join(', ')} is listed twice`);

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

    const existing = await q('SELECT * FROM allocations WHERE line_id = $1 ORDER BY table_no', [lineId]);
    const grn = Number(line.grn_qty);
    const r = String(reason || '').trim();

    /* BR-04 — anything past the first table is deliberate or it does not
       happen. Both routes to a second table come through here: one call
       naming several, and a later call adding one to a line already placed. */
    if ((existing.length || wanted.length > 1) && !r) {
      throw badRequest(
        existing.length
          ? `${line.part_no} is already on ${existing.map((e) => e.table_no).join(', ')} — say why it is also going to ${wanted.map((t) => t.tableNo).join(', ')} (BR-04)`
          : 'Splitting a line across tables must record a reason (BR-04)',
      );
    }

    const clash = wanted.filter((t) => existing.some((e) => e.table_no === t.tableNo));
    if (clash.length) {
      throw conflict(`${line.part_no} is already allocated to ${clash.map((t) => t.tableNo).join(', ')}`);
    }

    // Stated shares are shares of the line, so they cannot outrun it.
    let stated = existing.reduce((s, e) => s + Number(e.qty ?? 0), 0);
    for (const t of wanted) {
      if (t.qty === undefined || t.qty === null || t.qty === '') { t.qty = null; continue; }
      const n = Number(t.qty);
      if (!(n > 0)) throw badRequest(`${t.tableNo} was given a quantity of ${t.qty} — it must be greater than zero`);
      t.qty = n;
      stated += n;
    }
    if (stated > grn) {
      throw badRequest(
        `Those quantities total ${nf(stated)}, more than the GRN quantity of ${nf(grn)} ${line.uom}`,
      );
    }

    for (const t of wanted) {
      const id = await nextId('allocations', 'AL', 3, q);
      await q(
        'INSERT INTO allocations (id, line_id, table_no, qty, reason, allocated_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, lineId, t.tableNo, t.qty, r, req.user.id],
      );
    }

    const added = wanted.map((t) => (t.qty == null ? t.tableNo : `${t.tableNo} (${nf(t.qty)})`)).join(' + ');
    const before = existing.length ? existing.map((e) => e.table_no).join('+') : 'Unallocated';
    const tables = [...existing.map((e) => e.table_no), ...wanted.map((t) => t.tableNo)].sort();
    await audit({
      actorId: req.user.id,
      action: wanted.length > 1 || existing.length ? 'Table Allocation (Split)' : 'Table Allocation',
      reference: line.part_no,
      detail: `${line.invoice_no} → ${added}${r ? ` — ${r}` : ''}`,
      before, after: tables.join('+'),
    }, q);
    return { tables, added: wanted.map((t) => t.tableNo), split: tables.length > 1 };
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
