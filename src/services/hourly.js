import { all, get, run } from '../db/index.js';
import { shiftStats, tableStats, memberStats } from '../lib/compute.js';
import { nextId } from '../lib/ids.js';
import { settings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { sendMail, hourlyReportHtml } from './mailer.js';
import { config } from '../config.js';

/**
 * UC-06 — compiles and stores the hourly packing status report, then emails it.
 * Called both by the scheduler and by the Supervisor's "Generate & email now".
 */
export async function generateHourlyReport(shiftId, { actorId = 'system' } = {}) {
  const shift = await get('SELECT * FROM shifts WHERE id = $1', [shiftId]);
  if (!shift) throw new Error(`Unknown shift ${shiftId}`);

  const cfg = await settings();
  const st = await shiftStats(shiftId);
  const tables = await tableStats(shiftId);
  const members = (await memberStats(shiftId)).filter((m) => m.txns > 0);

  const occupied = tables.filter((t) => t.status === 'Occupied').length;
  const completed = tables.filter((t) => t.status === 'Completed').length;
  const summary = `${occupied} occupied · ${completed} completed`;

  const id = await nextId('hourly_reports', 'HR-', 2);
  const body = {
    packed: st.packed,
    pending: st.pending,
    tables: tables.map((t) => ({ table_no: t.table_no, member: t.member_name, status: t.status, packed: t.packed })),
    members: members.map((m) => ({ name: m.name, qty: m.qty, lines: m.lines, pouches: m.pouches, boxes: m.boxes })),
    exceptions: st.excOpen,
  };

  const mail = await sendMail({
    to: cfg.emails,
    subject: `SPD Pre-Packing · Hourly Status · ${shift.label}`,
    html: hourlyReportHtml({
      shiftLabel: shift.label,
      at: Date.now(),
      packed: st.packed,
      pending: st.pending,
      tables: summary,
      exceptions: st.excOpen,
      members,
    }),
    text: `Packed ${st.packed} · Pending ${st.pending} · Tables ${summary} · Open exceptions ${st.excOpen}`,
  });

  await run(
    `INSERT INTO hourly_reports (id, shift_id, generated_at, packed_qty, pending_qty, tables_summary,
                                 exceptions_count, emailed_to, email_status, body_json)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [id, shiftId, st.packed, st.pending, summary, st.excOpen, cfg.emails.join(', '), mail.status, JSON.stringify(body)],
  );

  await audit({
    actorId: actorId === 'system' ? null : actorId,
    action: 'Hourly Report',
    reference: id,
    detail: `${mail.sent ? 'Emailed to' : 'Recorded for'} ${cfg.emails.join(', ')} — ${mail.status}`,
    before: '—',
    after: `${st.packed} packed / ${st.pending} pending`,
  });

  return { id, shiftId, stats: st, mail, summary };
}

let timer = null;

/**
 * FR-8.1 — the scheduled job. It re-reads the configured interval on every
 * tick, so an Administrator changing it in the console takes effect without a
 * restart; and it only fires for shifts that are still Open, because a
 * finalised shift has nothing left to report hourly.
 */
export function startHourlyScheduler() {
  if (!config.hourlyEnabled) {
    console.log('[spd] hourly report scheduler disabled (set HOURLY_ENABLED=true to run it)');
    return () => {};
  }
  let lastRunAt = 0;

  const tick = async () => {
    try {
      const cfg = await settings({ fresh: true });
      const dueAfter = cfg.hourly * 60 * 1000;
      if (Date.now() - lastRunAt < dueAfter) return;
      const open = await all(`SELECT id FROM shifts WHERE status = 'Open' ORDER BY shift_date DESC LIMIT 3`);
      for (const s of open) await generateHourlyReport(s.id, { actorId: 'system' });
      lastRunAt = Date.now();
    } catch (err) {
      // NFR-6.2 — a failure here is logged and the shift carries on.
      console.error('[spd] hourly scheduler:', err.message);
    }
  };

  timer = setInterval(tick, 60 * 1000);
  timer.unref?.();
  console.log('[spd] hourly report scheduler started');
  return () => { if (timer) clearInterval(timer); timer = null; };
}
