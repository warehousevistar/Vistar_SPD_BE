import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { requireAuth, canRead, canSupervise } from '../middleware/auth.js';
import { wrap, notFound, badRequest } from '../middleware/error.js';
import { shiftLines, lineById, shiftTxns } from '../lib/compute.js';
import { settings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { buildLabelPdf, labelPayload, qrModules, barcodeWidths } from '../services/labels.js';

export const lineRoutes = Router();
lineRoutes.use(requireAuth);

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
  res.json({ line, txns, exceptions, allocations });
}));

/* ------------------------------------------------------- FR-3 ID labels --- */

/** Everything the client needs to draw the label preview exactly as it prints. */
lineRoutes.get('/labels/:lineId/preview', canRead, wrap(async (req, res) => {
  const line = await lineById(req.params.lineId);
  if (!line) throw notFound('No such GRN line');
  const cfg = await settings();
  const payload = labelPayload(line);
  res.json({
    line,
    template: cfg.labelTpl,
    payload,
    qr: qrModules(payload),
    barcode: barcodeWidths(line.part_no),
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
    const l = await get('SELECT * FROM grn_lines WHERE id = $1', [only]);
    if (!l) throw notFound('No such GRN line');
    lines = [l];
  } else {
    if (!shiftId) throw badRequest('shiftId is required');
    lines = await all('SELECT * FROM grn_lines WHERE shift_id = $1 ORDER BY invoice_no, part_no', [shiftId]);
    if (!lines.length) throw badRequest('This shift has no GRN lines to label yet');
  }
  const pdf = await buildLabelPdf(lines, { template: cfg.labelTpl });
  const name = only ? `SPD_LABEL_${lines[0].part_no}.pdf` : `SPD_ID_LABELS_${shiftId}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(pdf);
}));
