import { Router } from 'express';
import { all, get } from '../db/index.js';
import { requireAuth, canRead, canSupervise } from '../middleware/auth.js';
import { wrap, badRequest, notFound } from '../middleware/error.js';
import { shiftStats, shiftLines, shiftTxns, tableStats, memberStats } from '../lib/compute.js';
import { generateHourlyReport } from '../services/hourly.js';
import { buildWorkbook, buildCsv } from '../services/excelExport.js';
import { settings } from '../lib/settings.js';

export const reportRoutes = Router();
reportRoutes.use(requireAuth);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtD = (v) => {
  // A DATE column arrives as 'YYYY-MM-DD'. Formatting those parts directly
  // keeps a GRN date the date it is, whatever zone the server runs in.
  const plain = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
  if (plain) {
    const [y, m, d] = v.slice(0, 10).split('-');
    return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
  }
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
};
/** 'YYYY-MM-DD' for a filename, from a DATE column or a timestamp. */
const isoDay = (v) => (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));
const fmtTs = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
};
const durTxt = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/* ==================================================== FR-8 hourly reports === */

reportRoutes.get('/hourly', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const reports = await all(
    'SELECT * FROM hourly_reports WHERE shift_id = $1 ORDER BY generated_at DESC',
    [shiftId],
  );
  const cfg = await settings();
  res.json({ reports, interval: cfg.hourly, emails: cfg.emails });
}));

reportRoutes.get('/hourly/:id', canRead, wrap(async (req, res) => {
  const report = await get(
    `SELECT h.*, s.label AS shift_label FROM hourly_reports h JOIN shifts s ON s.id = h.shift_id WHERE h.id = $1`,
    [req.params.id],
  );
  if (!report) throw notFound('No such hourly report');
  res.json({ report });
}));

/** The Supervisor's "Generate & email now" — the same job the scheduler runs. */
reportRoutes.post('/hourly/generate', canSupervise, wrap(async (req, res) => {
  const { shiftId } = req.body ?? {};
  if (!shiftId) throw badRequest('shiftId is required');
  const out = await generateHourlyReport(shiftId, { actorId: req.user.id });
  const report = await get('SELECT * FROM hourly_reports WHERE id = $1', [out.id]);
  res.status(201).json({ report, mail: out.mail });
}));

/* ======================================================= FR-10 MIS report === */

/**
 * FR-10.2 — the MIS sliced five ways. `dim` selects the grouping; everything
 * else filters. BR-07: before the Supervisor finalises, the same figures are
 * returned marked `provisional`, so the screen can say so rather than hide.
 */
reportRoutes.get('/mis', canRead, wrap(async (req, res) => {
  const { shiftId, dim = 'line', invoice = '', table = '', member = '' } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');

  const shift = await get('SELECT * FROM shifts WHERE id = $1', [shiftId]);
  if (!shift) throw notFound('No such shift');

  const stats = await shiftStats(shiftId);
  const txns = await shiftTxns(shiftId, { invoice, tableNo: table, memberId: member });

  let rows;
  if (dim === 'line') {
    const lines = await shiftLines(shiftId, { invoice, tableNo: table, memberId: member });
    const perLine = {};
    for (const t of txns) {
      const g = (perLine[t.line_id] ??= { pouches: 0, boxes: 0 });
      g.pouches += Number(t.pouches);
      g.boxes += Number(t.boxes);
    }
    rows = lines.map((l) => ({
      key: l.id,
      invoice_no: l.invoice_no,
      part_no: l.part_no,
      part_desc: l.part_desc,
      grn_qty: Number(l.grn_qty),
      packed: Number(l.packed),
      pending: l.pending,
      pouches: perLine[l.id]?.pouches ?? 0,
      boxes: perLine[l.id]?.boxes ?? 0,
      tables: l.tables,
      status: l.status,
    }));
  } else {
    const keyOf = dim === 'inv' ? (t) => t.invoice_no : dim === 'table' ? (t) => t.table_no : (t) => t.member_id;
    const groups = {};
    for (const t of txns) {
      const k = keyOf(t);
      const g = (groups[k] ??= { key: k, qty: 0, pouches: 0, boxes: 0, txns: 0, lines: new Set(), label: k, member_name: t.member_name, table_no: t.table_no });
      g.qty += Number(t.qty);
      g.pouches += Number(t.pouches);
      g.boxes += Number(t.boxes);
      g.txns += 1;
      g.lines.add(t.line_id);
    }
    rows = Object.values(groups)
      .map((g) => ({ ...g, lines: g.lines.size }))
      .sort((a, b) => b.qty - a.qty);

    if (dim === 'table') {
      const tbls = await tableStats(shiftId);
      rows = rows.map((r) => ({ ...r, member_name: tbls.find((t) => t.table_no === r.key)?.member_name ?? null }));
    }
    if (dim === 'member') {
      const mems = await memberStats(shiftId);
      rows = rows.map((r) => {
        const m = mems.find((x) => x.id === r.key);
        return { ...r, label: m?.name ?? r.key, member_name: m?.name ?? r.key, table_no: m?.table_no ?? null };
      });
    }
  }

  const snapshots = await all(
    `SELECT m.*, s.label AS shift_label FROM mis_snapshots m JOIN shifts s ON s.id = m.shift_id
      WHERE m.shift_id = $1 ORDER BY m.generated_at DESC`,
    [shiftId],
  );

  res.json({
    shift,
    stats,
    dim,
    rows,
    snapshots,
    provisional: shift.status !== 'Finalised',   // BR-07
    generatedAt: snapshots[0]?.generated_at ?? null,
  });
}));

/* ======================================== FR-12.1 export (Excel and CSV) ==== */

const EXPORTS = {
  /** The transaction-level MIS, grouped exactly as the prototype's workbook. */
  async mis({ shiftId, invoice, table, member }) {
    const shift = await get('SELECT * FROM shifts WHERE id = $1', [shiftId]);
    const txns = await shiftTxns(shiftId, { invoice, tableNo: table, memberId: member });
    const lines = await shiftLines(shiftId);
    const pendingOf = Object.fromEntries(lines.map((l) => [l.id, l.pending]));
    return {
      file: `SPD_MIS_${isoDay(shift.shift_date)}`,
      title: 'SPD MIS',
      groups: [{ t: 'SHIFT', n: 2 }, { t: 'GRN LINE', n: 4 }, { t: 'EXECUTION', n: 5 }, { t: 'MIS METRICS', n: 4 }, { t: 'STATUS', n: 1 }],
      cols: ['Date', 'Txn ID', 'Invoice No.', 'Part Number', 'Description', 'UOM', 'Table No.', 'Member',
        'Start Time', 'Submit Time', 'Duration', 'Packed Qty', 'Pouches', 'Boxes', 'Line Pending Qty', 'Status'],
      rows: txns.map((t) => [
        fmtD(shift.shift_date), t.id, t.invoice_no, t.part_no, t.part_desc, t.uom, t.table_no, t.member_name,
        fmtTs(t.start_at), fmtTs(t.submit_at),
        durTxt(new Date(t.submit_at) - new Date(t.start_at)),
        Number(t.qty), t.pouches, t.boxes, pendingOf[t.line_id] ?? '', t.status,
      ]),
    };
  },

  /** The audit trail (NFR-3.3). */
  async audit({ action, q }) {
    const { auditRows } = await import('../lib/audit.js');
    const rows = await auditRows({ action: action || '', q: q || '', limit: 5000 });
    return {
      file: 'SPD_AUDIT_TRAIL',
      title: 'Audit Trail',
      groups: [],
      cols: ['Date', 'Time', 'User', 'Action', 'Reference', 'Detail', 'Before', 'After'],
      rows: rows.map((a) => [fmtD(a.at), fmtTs(a.at), a.actor_name ?? 'System', a.action, a.reference, a.detail, a.before_value, a.after_value]),
    };
  },

  /** The invoice/part listing with live reconciliation (FR-2.1). */
  async lines({ shiftId, invoice, vendor, status }) {
    const shift = await get('SELECT * FROM shifts WHERE id = $1', [shiftId]);
    const lines = await shiftLines(shiftId, { invoice, vendor, status });
    return {
      file: `SPD_GRN_LINES_${isoDay(shift.shift_date)}`,
      title: 'GRN Lines',
      groups: [{ t: 'GRN LINE', n: 6 }, { t: 'RECONCILIATION', n: 3 }, { t: 'FLOOR', n: 2 }],
      cols: ['Invoice No.', 'Part Number', 'Description', 'Vendor', 'UOM', 'GRN Date',
        'GRN Qty', 'Packed Qty', 'Pending Qty', 'Table(s)', 'Status'],
      rows: lines.map((l) => [
        l.invoice_no, l.part_no, l.part_desc, l.vendor, l.uom, fmtD(l.grn_date),
        Number(l.grn_qty), Number(l.packed), l.pending, l.tables.join(', '), l.status,
      ]),
    };
  },

  /** The hourly report log (FR-8.3). */
  async hourly({ shiftId }) {
    const reports = await all('SELECT * FROM hourly_reports WHERE shift_id = $1 ORDER BY generated_at', [shiftId]);
    return {
      file: `SPD_HOURLY_${shiftId}`,
      title: 'Hourly Reports',
      groups: [],
      cols: ['Report', 'Generated', 'Packed Qty', 'Pending Qty', 'Tables', 'Exceptions', 'Emailed To', 'Delivery'],
      rows: reports.map((h) => [h.id, `${fmtD(h.generated_at)} ${fmtTs(h.generated_at)}`, Number(h.packed_qty),
        Number(h.pending_qty), h.tables_summary, h.exceptions_count, h.emailed_to, h.email_status]),
    };
  },
};

reportRoutes.get('/export/:key/:fmt', canRead, wrap(async (req, res) => {
  const build = EXPORTS[req.params.key];
  if (!build) throw notFound(`No export named ${req.params.key}`);
  if (!['xlsx', 'csv'].includes(req.params.fmt)) throw badRequest('Export format must be xlsx or csv');
  const spec = await build(req.query);
  if (!spec.rows.length) throw badRequest('The current filter returns 0 rows — nothing to export');

  if (req.params.fmt === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${spec.file}.csv"`);
    return res.send(buildCsv(spec));
  }
  const buf = await buildWorkbook(spec);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${spec.file}.xlsx"`);
  return res.send(buf);
}));
