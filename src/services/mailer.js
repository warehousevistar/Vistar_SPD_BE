import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;

function getTransport() {
  if (transport) return transport;
  if (!config.smtp.host) return null;
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transport;
}

/**
 * FR-8.2 — sends the hourly report.
 *
 * With no SMTP host configured the report is still generated, stored and
 * viewable in the app (FR-8.3); only the delivery is skipped, and the return
 * value says so. A shift must not fail because the mail server is down —
 * NFR-6.2 asks for the failure to be diagnosable, not fatal.
 */
export async function sendMail({ to, subject, html, text }) {
  const t = getTransport();
  if (!t) return { sent: false, status: 'Not sent — no SMTP host configured', error: null };
  try {
    const info = await t.sendMail({ from: config.smtp.from, to: to.join(', '), subject, html, text });
    return { sent: true, status: `Sent ${info.messageId}`, error: null };
  } catch (err) {
    console.error('[spd] hourly report mail failed:', err.message);
    return { sent: false, status: `Delivery failed — ${err.message}`, error: err.message };
  }
}

/** The body of section 9.1's hourly packing report. */
export function hourlyReportHtml({ shiftLabel, at, packed, pending, tables, exceptions, members }) {
  const nf = (n) => Number(n).toLocaleString('en-IN');
  const time = new Date(at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const rows = members.length
    ? members.map((m) => `• ${m.name} — ${nf(m.qty)} qty · ${m.lines} lines`).join('<br>')
    : '—';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.65;color:#222">
  <p>Dear Supervisor,</p>
  <p>Automated status as of <b>${time}</b>:</p>
  <ul style="padding-left:18px">
    <li>Packed quantity: <b>${nf(packed)}</b></li>
    <li>Pending quantity: <b>${nf(pending)}</b></li>
    <li>Tables: ${tables}</li>
    <li>Open exceptions: <b>${exceptions}</b></li>
  </ul>
  <p><b>Member-wise:</b><br>${rows}</p>
  <p style="color:#666">This report was generated automatically by VST SPD for ${shiftLabel}. No reply is required.</p>
</div>`;
}
