import { Router } from 'express';
import { all, get } from '../db/index.js';
import { requireAuth, canRead } from '../middleware/auth.js';
import { wrap, badRequest, notFound } from '../middleware/error.js';
import { shiftStats, tableStats, memberStats, shiftLines } from '../lib/compute.js';
import { settings } from '../lib/settings.js';

export const dashboardRoutes = Router();
dashboardRoutes.use(requireAuth);

/**
 * UC-09 / FR-11 — one call backs the whole dashboard, so the tiles, the
 * productivity bars and the invoice/part table are all computed from the same
 * instant (NFR-7.2). Splitting it would let the tiles and the table disagree
 * by one submission on a busy floor.
 */
dashboardRoutes.get('/dashboard', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');

  const shift = await get(
    `SELECT s.*, u.name AS final_by_name FROM shifts s LEFT JOIN users u ON u.id = s.final_by WHERE s.id = $1`,
    [shiftId],
  );
  if (!shift) throw notFound('No such shift');

  const cfg = await settings();
  const [stats, tables, members, lines, batch, hourly] = await Promise.all([
    shiftStats(shiftId),
    tableStats(shiftId),
    memberStats(shiftId),
    shiftLines(shiftId),
    get('SELECT id FROM grn_batches WHERE shift_id = $1 ORDER BY uploaded_at DESC LIMIT 1', [shiftId]),
    get('SELECT COUNT(*)::int AS n FROM hourly_reports WHERE shift_id = $1', [shiftId]),
  ]);

  res.json({
    shift,
    stats,
    tables,
    members: members.filter((m) => m.txns > 0),
    lines,
    batchId: batch?.id ?? null,
    hourlyCount: hourly.n,
    refreshSeconds: cfg.refresh,
    generatedAt: new Date().toISOString(),
  });
}));

/** The bell menu of the prototype — the three things a supervisor is told about. */
dashboardRoutes.get('/notifications', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const cfg = await settings();
  const stats = await shiftStats(shiftId);
  const last = await get(
    'SELECT id, generated_at FROM hourly_reports WHERE shift_id = $1 ORDER BY generated_at DESC LIMIT 1',
    [shiftId],
  );
  res.json({
    notifications: [
      {
        severity: stats.excOpen ? 'bad' : 'info',
        text: `${stats.excOpen} exception${stats.excOpen === 1 ? '' : 's'} awaiting supervisor remarks`,
      },
      {
        severity: 'info',
        text: last
          ? `Hourly report sent at ${new Date(last.generated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} to ${cfg.emails[0]}`
          : `Hourly report pending to ${cfg.emails[0]}`,
      },
      {
        severity: stats.pending > 0 ? 'warn' : 'info',
        text: stats.pending > 0
          ? `${Number(stats.pending).toLocaleString('en-IN')} qty still pending across ${stats.lines - stats.linesPacked} lines`
          : 'All lines fully packed',
      },
    ],
  });
}));

/** The top-bar search: invoice, part number or description, within the shift. */
dashboardRoutes.get('/search', canRead, wrap(async (req, res) => {
  const { shiftId, q = '' } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  if (!String(q).trim()) return res.json({ results: [] });
  const lines = await shiftLines(shiftId, { q: String(q) });
  res.json({ results: lines.slice(0, 10) });
}));

/** Vendor / invoice lists used by the filter bars. */
dashboardRoutes.get('/facets', canRead, wrap(async (req, res) => {
  const { shiftId } = req.query;
  if (!shiftId) throw badRequest('shiftId is required');
  const invoices = (await all('SELECT DISTINCT invoice_no FROM grn_lines WHERE shift_id = $1 ORDER BY invoice_no', [shiftId])).map((r) => r.invoice_no);
  const vendors = (await all('SELECT DISTINCT vendor FROM grn_lines WHERE shift_id = $1 ORDER BY vendor', [shiftId])).map((r) => r.vendor);
  const tables = (await all('SELECT table_no FROM packing_tables WHERE active ORDER BY sort_order, table_no')).map((r) => r.table_no);
  const members = await all(`SELECT id, name FROM users WHERE role = 'Member' AND active ORDER BY name`);
  res.json({ invoices, vendors, tables, members });
}));
