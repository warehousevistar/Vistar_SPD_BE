import { Router } from 'express';
import { all, get, run, tx } from '../db/index.js';
import { requireAuth, canSupervise, canRead } from '../middleware/auth.js';
import { grnUpload, handleUploadErrors } from '../middleware/upload.js';
import { wrap, badRequest, conflict, notFound } from '../middleware/error.js';
import { parseGrnFile } from '../services/grnImport.js';
import { settings } from '../lib/settings.js';
import { nextBatchId, lineId } from '../lib/ids.js';
import { audit } from '../lib/audit.js';

export const grnRoutes = Router();
grnRoutes.use(requireAuth);

/* ------------------------------------------------------------- shifts --- */

grnRoutes.get('/shifts', canRead, wrap(async (_req, res) => {
  const shifts = await all(
    `SELECT s.*, u.name AS final_by_name,
            (SELECT COUNT(*)::int FROM grn_lines l WHERE l.shift_id = s.id) AS line_count
       FROM shifts s LEFT JOIN users u ON u.id = s.final_by
      ORDER BY s.shift_date DESC, s.id DESC`,
  );
  res.json({ shifts });
}));

grnRoutes.post('/shifts', canSupervise, wrap(async (req, res) => {
  const { id, label, shiftDate } = req.body ?? {};
  if (!id || !label || !shiftDate) throw badRequest('A shift needs an id, a label and a date');
  const existing = await get('SELECT id FROM shifts WHERE id = $1', [id]);
  if (existing) throw conflict(`Shift ${id} already exists`);
  const { row } = await run(
    'INSERT INTO shifts (id, label, shift_date) VALUES ($1, $2, $3) RETURNING *',
    [id, label, shiftDate],
  );
  await audit({ actorId: req.user.id, action: 'Shift Created', reference: id, detail: label, before: '—', after: 'Open' });
  res.status(201).json({ shift: row });
}));

/* ------------------------------------------------- FR-1.6 import history --- */

grnRoutes.get('/grn/batches', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  const params = [];
  let where = '';
  if (shiftId) { params.push(shiftId); where = `WHERE b.shift_id = $1`; }
  const batches = await all(
    `SELECT b.*, u.name AS uploaded_by_name, s.label AS shift_label
       FROM grn_batches b
       LEFT JOIN users u ON u.id = b.uploaded_by
       JOIN shifts s ON s.id = b.shift_id
       ${where}
      ORDER BY b.uploaded_at DESC`,
    params,
  );
  res.json({ batches });
}));

/* --------------------------------------------------------- FR-1.1 upload --- */

/**
 * UC-01. The file is validated in full before a single row is written, so a
 * rejected upload leaves the database exactly as it was (FR-1.3) — the
 * supervisor never has to work out how much of a bad file got in.
 *
 * `confirm=true` is the BR-08 override: a duplicate batch for the same
 * date/invoice set is blocked unless the Supervisor confirms an intentional
 * re-upload and gives a reason, which is then audit-logged.
 */
grnRoutes.post('/grn/upload', canSupervise, grnUpload, handleUploadErrors, wrap(async (req, res) => {
  if (!req.file) throw badRequest('No file was attached to the upload');
  const shiftId = req.body.shiftId;
  const confirm = String(req.body.confirm || '') === 'true';
  const reuploadReason = String(req.body.reason || '').trim();

  const shift = await get('SELECT * FROM shifts WHERE id = $1', [shiftId]);
  if (!shift) throw badRequest('Select the shift this GRN report belongs to');
  if (shift.status === 'Finalised') {
    throw conflict(`${shift.label} has been finalised — reopen it before importing more GRN data (BR-06)`);
  }

  const cfg = await settings();
  const defaultDate = new Date(shift.shift_date).toISOString().slice(0, 10);
  const { rows, errors } = await parseGrnFile({
    buffer: req.file.buffer,
    filename: req.file.originalname,
    requiredCols: cfg.grnCols,
    defaultGrnDate: defaultDate,
  });

  if (!rows.length) {
    throw badRequest(
      `${req.file.originalname} produced no importable rows — ${errors.length} problem${errors.length === 1 ? '' : 's'} found (FR-1.3)`,
      errors,
    );
  }

  /* FR-1.4 / BR-08 — a batch that repeats invoice+part pairs already imported
     for this shift would double-count the GRN quantity. */
  const keys = rows.map((r) => `${r.invoice_no}|${r.part_no}`);
  const clashes = await all(
    `SELECT l.invoice_no, l.part_no, l.batch_id, b.file_name, b.uploaded_at, u.name AS uploaded_by_name
       FROM grn_lines l
       JOIN grn_batches b ON b.id = l.batch_id
       LEFT JOIN users u ON u.id = b.uploaded_by
      WHERE l.shift_id = $1 AND (l.invoice_no || '|' || l.part_no) = ANY($2::text[])`,
    [shiftId, keys],
  );
  if (clashes.length && !confirm) {
    throw conflict(
      `${clashes.length} of these ${rows.length} rows are already imported for ${shift.label} — importing again would double-count the GRN quantity (BR-08)`,
      {
        duplicate: true,
        rows: clashes.slice(0, 25),
        batches: [...new Set(clashes.map((c) => c.batch_id))],
      },
    );
  }
  if (clashes.length && !reuploadReason) {
    throw badRequest('A confirmed re-upload must carry a reason (BR-08)');
  }

  const batchId = await nextBatchId(shift.shift_date);
  const inserted = await tx(async (q) => {
    await q(
      `INSERT INTO grn_batches (id, file_name, shift_id, uploaded_at, uploaded_by, row_count, rejected_count, status, reupload_reason)
       VALUES ($1, $2, $3, now(), $4, $5, $6, 'Imported', $7)`,
      [batchId, req.file.originalname, shiftId, req.user.id, rows.length, errors.length, reuploadReason],
    );

    // Line ids continue the global series so they stay unique across batches.
    const [{ last }] = await q(`SELECT COALESCE(MAX(SUBSTRING(id FROM 2)::int), 0) AS last FROM grn_lines WHERE id ~ '^L[0-9]+$'`);
    let seq = Number(last);

    for (const r of rows) {
      seq += 1;
      await q(
        `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, part_desc, uom, grn_qty, vendor, grn_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [lineId(seq), batchId, shiftId, r.invoice_no, r.part_no, r.part_desc, r.uom, r.grn_qty, r.vendor, r.grn_date],
      );
    }

    if (clashes.length) {
      await q(`UPDATE grn_batches SET status = 'Replaced' WHERE id = ANY($1::text[])`,
        [[...new Set(clashes.map((c) => c.batch_id))]]);
    }

    await audit({
      actorId: req.user.id,
      action: clashes.length ? 'GRN Re-upload' : 'GRN Import',
      reference: batchId,
      detail: clashes.length
        ? `${req.file.originalname} · ${rows.length} rows · confirmed duplicate re-upload — ${reuploadReason}`
        : `${req.file.originalname} · ${rows.length} rows validated & imported · ${errors.length} rejected`,
      before: '—',
      after: `${rows.length} lines`,
    }, q);

    return rows.length;
  });

  res.status(201).json({
    batchId,
    imported: inserted,
    rejected: errors.length,
    errors,
    replaced: [...new Set(clashes.map((c) => c.batch_id))],
  });
}));

/** The rejected-row list as a downloadable file, matching the prototype's "Error file". */
grnRoutes.post('/grn/errors.csv', canSupervise, wrap(async (req, res) => {
  const errors = Array.isArray(req.body?.errors) ? req.body.errors : [];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [['Row', 'Column', 'Value', 'Error'].map(q).join(','),
    ...errors.map((e) => [e.row, e.column, e.value, e.error].map(q).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="GRN_UPLOAD_ERRORS.csv"');
  res.send('﻿' + body);
}));

grnRoutes.delete('/grn/batches/:id', canSupervise, wrap(async (req, res) => {
  const batch = await get('SELECT * FROM grn_batches WHERE id = $1', [req.params.id]);
  if (!batch) throw notFound('No such GRN batch');
  const [{ n }] = await all(
    `SELECT COUNT(*)::int AS n FROM packing_txns t JOIN grn_lines l ON l.id = t.line_id WHERE l.batch_id = $1`,
    [req.params.id],
  );
  if (n > 0) throw conflict(`${batch.id} already has ${n} packing transaction${n === 1 ? '' : 's'} against it and cannot be removed`);
  await run('DELETE FROM grn_batches WHERE id = $1', [req.params.id]);
  await audit({
    actorId: req.user.id, action: 'GRN Batch Removed', reference: batch.id,
    detail: `${batch.file_name} · ${batch.row_count} lines discarded before any packing`, before: 'Imported', after: 'Deleted',
  });
  res.json({ ok: true });
}));
