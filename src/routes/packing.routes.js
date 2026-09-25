import { Router } from 'express';
import { all, get } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { wrap, badRequest, forbidden } from '../middleware/error.js';
import { startPacking, submitPacking, previewSubmission } from '../lib/packing.js';
import { settings } from '../lib/settings.js';
import { memberStats } from '../lib/compute.js';

export const packingRoutes = Router();
packingRoutes.use(requireAuth);

/* A Member acts on their own table only (BR-05). Admins reach these routes too,
   so the "view as Table Member" preview in the top bar walks the same screens —
   but an Admin previewing does so against a table they name, never a member's
   own session. */
const canPack = requireRole('Member', 'Administrator');

/** The table this request acts on: a Member's own, or the one an Admin names. */
function tableFor(req) {
  if (req.user.role === 'Member') {
    if (!req.tableNo) throw forbidden('You are not assigned to a packing table — ask the Supervisor to assign one');
    return req.tableNo;
  }
  const t = req.query.table || req.body?.tableNo;
  if (!t) throw badRequest('tableNo is required when previewing as an Administrator');
  return t;
}

/**
 * UC-04 — the member's work queue: only the lines allocated to their own table
 * (FR-5.2/BR-05), so a part number is selected and never typed.
 */
packingRoutes.get('/my/queue', canPack, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const tableNo = tableFor(req);

  const shift = await get('SELECT * FROM shifts WHERE id = $1', [shiftId]);
  if (!shift) throw badRequest('No such shift');

  const lines = (await all(
    `SELECT l.*, a.qty AS my_share, a.reason AS split_reason,
            COALESCE(p.packed, 0)  AS packed,
            COALESCE(p.pouches, 0) AS pouches,
            COALESCE(p.boxes, 0)   AS boxes,
            COALESCE(x.open_exceptions, 0) AS open_exceptions,
            COALESCE(r.running, 0) AS running,
            1 AS allocations
       FROM allocations a
       JOIN grn_lines l ON l.id = a.line_id
       LEFT JOIN (SELECT line_id, SUM(qty) AS packed, SUM(pouches) AS pouches, SUM(boxes) AS boxes
                    FROM packing_txns WHERE status <> 'Started' GROUP BY line_id) p ON p.line_id = l.id
       LEFT JOIN (SELECT line_id, COUNT(*) AS open_exceptions FROM exceptions WHERE resolved_at IS NULL GROUP BY line_id) x ON x.line_id = l.id
       LEFT JOIN (SELECT line_id, COUNT(*) AS running FROM packing_txns WHERE status = 'Started' GROUP BY line_id) r ON r.line_id = l.id
      WHERE a.table_no = $1 AND l.shift_id = $2
      ORDER BY l.invoice_no, l.part_no`,
    [tableNo, shiftId],
  )).map((l) => ({
    ...l,
    pending: Number(l.grn_qty) - Number(l.packed),
    status: Number(l.open_exceptions) > 0 ? 'Exception'
      : Number(l.packed) >= Number(l.grn_qty) ? 'Completed'
      : Number(l.packed) > 0 || Number(l.running) > 0 ? 'In Progress'
      : 'Allocated',
  }));

  const memberId = req.user.role === 'Member' ? req.user.id : (req.query.member || req.user.id);
  const running = await get(
    `SELECT t.*, l.part_no, l.part_desc, l.invoice_no, l.grn_qty, l.uom
       FROM packing_txns t JOIN grn_lines l ON l.id = t.line_id
      WHERE t.member_id = $1 AND t.status = 'Started'`,
    [memberId],
  );
  const stats = (await memberStats(shiftId)).find((m) => m.id === memberId)
    ?? { txns: 0, qty: 0, pouches: 0, boxes: 0, lines: 0, last_submit: null };

  const cfg = await settings();
  res.json({
    tableNo,
    shift,
    locked: shift.status === 'Finalised',
    lines,
    running: running ? { ...running, packed_so_far: null } : null,
    stats,
    threshold: cfg.threshold,
  });
}));

/** FR-6.1 — Start Packing. The start time is the server's, never the client's. */
packingRoutes.post('/my/start', canPack, wrap(async (req, res) => {
  const { lineId } = req.body ?? {};
  if (!lineId) throw badRequest('Select the part number you are starting on');
  const tableNo = tableFor(req);
  const memberId = req.user.role === 'Member' ? req.user.id : (req.body.memberId || req.user.id);
  const out = await startPacking({ lineId, memberId, tableNo });
  res.status(201).json(out);
}));

/** FR-6.2/6.3/6.4 — Submit. Validation and exception flagging live in lib/packing.js. */
packingRoutes.post('/my/submit', canPack, wrap(async (req, res) => {
  const { txnId, qty, pouches, boxes } = req.body ?? {};
  if (!txnId) throw badRequest('No packing transaction to submit');
  const memberId = req.user.role === 'Member' ? req.user.id : (req.body.memberId || req.user.id);
  const out = await submitPacking({ txnId, memberId, qty, pouches, boxes });
  res.json(out);
}));

/**
 * The live warning the member sees as they type (the prototype's pkWarn).
 * Computed server-side so the threshold that warns is the same value that
 * flags — a client-side copy drifts the moment an Admin changes it.
 */
packingRoutes.get('/my/preview', canPack, wrap(async (req, res) => {
  const { lineId, qty } = req.query;
  if (!lineId) throw badRequest('lineId is required');
  const line = await get('SELECT grn_qty FROM grn_lines WHERE id = $1', [lineId]);
  if (!line) throw badRequest('No such GRN line');
  const p = await get(`SELECT COALESCE(SUM(qty),0) AS packed FROM packing_txns WHERE line_id = $1 AND status <> 'Started'`, [lineId]);
  const cfg = await settings();
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return res.json({ hint: null });
  res.json({
    hint: await previewSubmission({
      grnQty: line.grn_qty, packed: p.packed, qty: n, threshold: cfg.threshold,
    }),
  });
}));

/** My Submissions — every Start/Submit this member made, newest first. */
packingRoutes.get('/my/history', canPack, wrap(async (req, res) => {
  const { shiftId } = req.query;
  const memberId = req.user.role === 'Member' ? req.user.id : (req.query.member || req.user.id);
  const params = [memberId];
  let scope = '';
  if (shiftId) { params.push(shiftId); scope = `AND l.shift_id = $2`; }
  const txns = await all(
    `SELECT t.*, l.part_no, l.invoice_no, l.uom, l.grn_qty
       FROM packing_txns t JOIN grn_lines l ON l.id = t.line_id
      WHERE t.member_id = $1 AND t.status <> 'Started' ${scope}
      ORDER BY t.submit_at DESC`,
    params,
  );
  res.json({ txns });
}));
