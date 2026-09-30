import { Router } from 'express';
import { all, get, run, tx } from '../db/index.js';
import { requireAuth, canRead, canSupervise } from '../middleware/auth.js';
import { wrap, notFound, badRequest, conflict } from '../middleware/error.js';
import { shiftLines, lineById, shiftTxns } from '../lib/compute.js';
import { settings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { buildLabelPdf, labelPayload, labelUnits, qrModules } from '../services/labels.js';

export const lineRoutes = Router();
lineRoutes.use(requireAuth);

const nf = (n) => Number(n).toLocaleString('en-IN');

/**
 * FR-3.1 — a GRN line with the two things the label prints that the line does
 * not itself hold: who is packing it and on what day.
 *
 * Neither is known when the label is printed. The ID Labels screen runs before
 * table allocation and long before anyone starts, so the best the sheet can do
 * is name the members standing at the tables the line has been sent to, and
 * the date of the shift it belongs to. A line not yet allocated prints neither,
 * which is the honest answer — and the reason `buildLabelPdf` treats both as
 * optional rather than expecting them.
 *
 * A line can now sit on several tables, so `packer` is aggregated: two names
 * where the work is genuinely shared, and the label's own field width decides
 * how much of that fits.
 */
const LABEL_COLUMNS = `
  l.*,
  (SELECT s.shift_date FROM shifts s WHERE s.id = l.shift_id) AS packed_on,
  (SELECT STRING_AGG(DISTINCT u.name, ', ' ORDER BY u.name)
     FROM allocations a
     JOIN packing_tables pt ON pt.table_no = a.table_no
     JOIN users u ON u.id = pt.member_id
    WHERE a.line_id = l.id) AS packer
  FROM grn_lines l`;

/* ------------------------------------- FR-2.1/2.2 invoice & part listing --- */

lineRoutes.get('/lines', canRead, wrap(async (req, res) => {
  const { shiftId, invoice = '', vendor = '', status = '', q = '', table = '', member = '' } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const lines = await shiftLines(shiftId, { invoice, vendor, status, q, tableNo: table, memberId: member });
  const vendors = [...new Set((await all('SELECT DISTINCT vendor FROM grn_lines WHERE shift_id = $1 ORDER BY vendor', [shiftId])).map((r) => r.vendor))];
  const invoices = [...new Set(lines.map((l) => l.invoice_no))].sort();
  res.json({ lines, invoices, vendors });
}));

lineRoutes.get('/lines/:id', canRead, wrap(async (req, res) => {
  const line = await lineById(req.params.id);
  if (!line) throw notFound('No such GRN line');
  const txns = await shiftTxns(line.shift_id, { lineId: line.id, includeRunning: true });
  const exceptions = await all(
    `SELECT e.*, u.name AS resolved_by_name FROM exceptions e LEFT JOIN users u ON u.id = e.resolved_by
      WHERE e.line_id = $1 ORDER BY e.created_at DESC`,
    [line.id],
  );
  const allocations = await all(
    `SELECT a.*, u.name AS allocated_by_name FROM allocations a LEFT JOIN users u ON u.id = a.allocated_by
      WHERE a.line_id = $1 ORDER BY a.allocated_at`,
    [line.id],
  );
  const adjustments = await all(
    `SELECT j.*, u.name AS created_by_name FROM qty_adjustments j LEFT JOIN users u ON u.id = j.created_by
      WHERE j.line_id = $1 ORDER BY j.created_at`,
    [line.id],
  );
  res.json({ line, txns, exceptions, allocations, adjustments });
}));

/**
 * BR-01 — closing out a remainder that will never be packed.
 *
 * Pending is GRN minus packed and is computed, never stored, so there is no
 * "remaining quantity" field to edit. What a Supervisor is really saying when
 * they close a line with five outstanding is *those five are not coming* —
 * damaged, short-shipped, the wrong part in the box. So it is recorded as its
 * own term with the reason attached, and neither of the other two is touched:
 * grn_qty stays the figure SAP sent, and the member's 95 stays 95 rather than
 * quietly becoming 100 on their productivity line.
 *
 * The sign is free, so a close-out on the wrong line is undone by entering its
 * opposite rather than by deleting the record of it. What is not free is the
 * result: a line can never end up with negative pending or more outstanding
 * than it was received with.
 */
lineRoutes.post('/lines/:id/adjust', canSupervise, wrap(async (req, res) => {
  const qty = Number(req.body?.qty);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isFinite(qty) || qty === 0) throw badRequest('Enter a quantity to write off');
  if (!reason) throw badRequest('A quantity adjustment must record a reason');

  const out = await tx(async (q) => {
    const [line] = await q(
      `SELECT l.*, s.status AS shift_status, s.label AS shift_label
         FROM grn_lines l JOIN shifts s ON s.id = l.shift_id
        WHERE l.id = $1 FOR UPDATE OF l`,
      [req.params.id],
    );
    if (!line) throw notFound('No such GRN line');
    if (line.shift_status === 'Finalised') {
      throw conflict(`${line.shift_label} is finalised — reopen the shift to adjust quantities (BR-06)`);
    }

    const [sums] = await q(
      `SELECT COALESCE((SELECT SUM(qty) FROM packing_txns WHERE line_id = $1 AND status <> 'Started'), 0) AS packed,
              COALESCE((SELECT SUM(qty) FROM qty_adjustments WHERE line_id = $1), 0) AS adjusted`,
      [line.id],
    );
    const grn = Number(line.grn_qty);
    const packed = Number(sums.packed);
    const was = Number(sums.adjusted);
    const pending = grn - packed - was;
    const now = pending - qty;

    if (now < 0) {
      throw badRequest(
        `${nf(qty)} is more than the ${nf(pending)} ${line.uom} still outstanding on ${line.part_no}`,
      );
    }
    if (now > grn - packed) {
      throw badRequest(`That would leave more outstanding than the GRN quantity of ${nf(grn)} ${line.uom}`);
    }

    const id = await nextId('qty_adjustments', 'QA', 4, q);
    await q(
      'INSERT INTO qty_adjustments (id, line_id, qty, reason, created_by) VALUES ($1, $2, $3, $4, $5)',
      [id, line.id, qty, reason, req.user.id],
    );
    await audit({
      actorId: req.user.id, action: 'Quantity Adjustment', reference: line.part_no,
      detail: `${line.invoice_no} · ${qty > 0 ? 'wrote off' : 'restored'} ${nf(Math.abs(qty))} ${line.uom} — ${reason}`,
      before: `${nf(pending)} pending`, after: `${nf(now)} pending`,
    }, q);
    return { id, pending: now, adjusted: was + qty };
  });

  res.status(201).json(out);
}));

/* ------------------------------------------------------- FR-3 ID labels --- */

/** Everything the client needs to draw the label preview exactly as it prints. */
lineRoutes.get('/labels/:lineId/preview', canRead, wrap(async (req, res) => {
  const line = await lineById(req.params.lineId);
  if (!line) throw notFound('No such GRN line');
  const cfg = await settings();
  /* FR-3.5 — a line with an MOQ prints one label per pack plus a remainder, so
     the preview has to show each of them: the quantity, and therefore the QR,
     differs between them. A line without an MOQ yields exactly one, which is
     the FR-3.1 label unchanged. */
  const labels = labelUnits(line).map((u) => {
    const payload = labelPayload(u);
    return {
      index: u.label_index,
      of: u.label_of,
      qty: u.label_qty,
      payload,
      qr: qrModules(payload),
    };
  });
  res.json({
    line,
    template: cfg.labelTpl,
    labels,
    // The first label's fields, kept flat for callers that predate the split.
    payload: labels[0].payload,
    qr: labels[0].qr,
    alreadyPrinted: Number(line.label_copies ?? 0) > 0,
  });
}));

lineRoutes.get('/labels/log', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const rows = await all(
    `SELECT p.*, l.part_no, l.invoice_no, u.name AS printed_by_name
       FROM labels_printed p
       JOIN grn_lines l ON l.id = p.line_id
       LEFT JOIN users u ON u.id = p.printed_by
      WHERE l.shift_id = $1
      ORDER BY p.printed_at DESC
      LIMIT 200`,
    [shiftId],
  );
  res.json({ prints: rows });
}));

/**
 * FR-3.3 / BR-09 — a reprint must carry a reason, and both the print and the
 * reason go into the audit trail. The server decides whether this is a reprint
 * from what it has already recorded, rather than trusting a flag from the
 * client, because that flag is exactly what a reprint would want to omit.
 */
lineRoutes.post('/labels/:lineId/print', canSupervise, wrap(async (req, res) => {
  const line = await get('SELECT * FROM grn_lines WHERE id = $1', [req.params.lineId]);
  if (!line) throw notFound('No such GRN line');
  const copies = Math.max(1, Number(req.body?.copies) || 1);
  const reason = String(req.body?.reason || '').trim();

  const prior = await get('SELECT COUNT(*)::int AS n FROM labels_printed WHERE line_id = $1', [line.id]);
  const isReprint = prior.n > 0;
  if (isReprint && !reason) throw badRequest('A reprint must be logged with a reason (BR-09)');

  await run(
    'INSERT INTO labels_printed (line_id, copies, printed_by, reason) VALUES ($1, $2, $3, $4)',
    [line.id, copies, req.user.id, reason],
  );
  if (isReprint) {
    await audit({
      actorId: req.user.id, action: 'Label Reprint', reference: line.part_no,
      detail: reason, before: '—', after: `Reprinted ×${copies}`,
    });
  } else {
    await audit({
      actorId: req.user.id, action: 'Label Print', reference: line.part_no,
      detail: `${line.invoice_no} · ${copies} cop${copies === 1 ? 'y' : 'ies'} · ${(await settings()).labelTpl}`,
      before: '—', after: 'Printed',
    });
  }
  res.json({ ok: true, reprint: isReprint, copies });
}));

/** FR-3.2 — the printable PDF, for one line or the whole shift. */
lineRoutes.get('/labels/sheet.pdf', canSupervise, wrap(async (req, res) => {
  const { shiftId, lineId: only } = req.query;
  const cfg = await settings();
  let lines;
  if (only) {
    const l = await get(`SELECT ${LABEL_COLUMNS} WHERE l.id = $1`, [only]);
    if (!l) throw notFound('No such GRN line');
    lines = [l];
  } else {
    if (!shiftId) throw badRequest('shiftId is required');
    lines = await all(
      `SELECT ${LABEL_COLUMNS} WHERE l.shift_id = $1 ORDER BY l.invoice_no, l.part_no`,
      [shiftId],
    );
    if (!lines.length) throw badRequest('This shift has no GRN lines to label yet');
  }
  const pdf = await buildLabelPdf(lines, { template: cfg.labelTpl });
  const name = only ? `SPD_LABEL_${lines[0].part_no}.pdf` : `SPD_ID_LABELS_${shiftId}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(pdf);
}));
