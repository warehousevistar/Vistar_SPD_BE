/**
 * Seeds the demo shift that the approved prototype shows.
 *
 * The figures are not arbitrary: the prototype generated them from a fixed
 * seed, and this file ports the same generator so a freshly seeded database
 * renders the screens with the same invoices, quantities, timings and the one
 * deliberate over-pack that produces the Excess Entry exception. That is what
 * lets the Flutter build be compared against the signed-off HTML side by side.
 *
 *   node src/db/seed.js           seed if empty
 *   node src/db/seed.js --reset   wipe the operational tables and seed again
 */
import bcrypt from 'bcryptjs';
import { pool, migrate, get, run, tx } from './index.js';
import { pad } from '../lib/ids.js';

/* ---- the prototype's deterministic generator, ported verbatim ---------- */
let _seed = 20260909;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];

const USERS = [
  { id: 'sup.rmenon', name: 'Rajesh Menon',    emp: 'EMP-1002', role: 'Supervisor',    email: 'rajesh.menon@vistarlogitek.com', device: 'SUP-DESK-01' },
  { id: 'adm.itcell', name: 'Deepa Krishnan',  emp: 'EMP-0110', role: 'Administrator', email: 'it.spd@vistarlogitek.com',       device: 'IT-DESK-02' },
  { id: 'mgt.avohra', name: 'Anita Vohra',     emp: 'EMP-0201', role: 'Management',    email: 'anita.vohra@vistarlogitek.com',  device: 'MGT-WEB-01' },
  { id: 'tm.ssingh',  name: 'Sandeep Singh',   emp: 'EMP-4412', role: 'Member', email: '', device: 'TAB-T1' },
  { id: 'tm.pnair',   name: 'Priya Nair',      emp: 'EMP-4425', role: 'Member', email: '', device: 'TAB-T2' },
  { id: 'tm.mfarooq', name: 'Mohammed Farooq', emp: 'EMP-4418', role: 'Member', email: '', device: 'TAB-T3' },
  { id: 'tm.lthomas', name: 'Litty Thomas',    emp: 'EMP-4437', role: 'Member', email: '', device: 'TAB-T4' },
  { id: 'tm.avarma',  name: 'Anil Varma',      emp: 'EMP-4431', role: 'Member', email: '', device: 'TAB-T5' },
  { id: 'tm.gk',      name: 'Gopal Krishna',   emp: 'EMP-4440', role: 'Member', email: '', device: 'TAB-T6' },
];

const TABLES = [
  { no: 'T-01', member: 'tm.ssingh' }, { no: 'T-02', member: 'tm.pnair' },
  { no: 'T-03', member: 'tm.mfarooq' }, { no: 'T-04', member: 'tm.lthomas' },
  { no: 'T-05', member: 'tm.avarma' }, { no: 'T-06', member: 'tm.gk' },
  { no: 'T-07', member: null }, { no: 'T-08', member: null },
];

const SHIFTS = [
  { id: 'A-2026-09-09', lbl: 'Shift A · 09-Sep-2026', date: '2026-09-09', status: 'Open', finalBy: null, finalTs: null, resubmits: 0 },
  { id: 'A-2026-09-08', lbl: 'Shift A · 08-Sep-2026', date: '2026-09-08', status: 'Finalised', finalBy: 'sup.rmenon', finalTs: new Date(2026, 8, 8, 17, 42, 10), resubmits: 1 },
];

const VENDORS = ['Sunrise Auto Components', 'Kranti Pressings', 'Meraki Polymers', 'DynaFast Fasteners',
  'Shakthi Rubber Works', 'NovaTrim Interiors', 'BlueVolt Harness', 'Precision Springs India'];

const BATCHES = [
  { id: 'GRN-0909-01', file: 'GRN_SAP_EXPORT_09SEP_S1.xlsx', shift: 'A-2026-09-09', ts: new Date(2026, 8, 9, 8, 12, 40), by: 'sup.rmenon', rejected: 0 },
  { id: 'GRN-0908-01', file: 'GRN_SAP_EXPORT_08SEP_S1.xlsx', shift: 'A-2026-09-08', ts: new Date(2026, 8, 8, 8, 9, 12),  by: 'sup.rmenon', rejected: 2 },
];

const PARTS_POOL = [
  ['90210-ABX', 'Front Bumper Bracket LH', 'NOS'], ['90211-ABX', 'Front Bumper Bracket RH', 'NOS'],
  ['82111-WHM', 'Main Wiring Harness', 'NOS'], ['16571-RHU', 'Radiator Hose Upper', 'NOS'],
  ['90119-FKM', 'Fastener Kit M8 Zinc', 'SET'], ['48231-CSP', 'Coil Spring Rear', 'NOS'],
  ['67861-WSR', 'Door Weatherstrip Rear', 'NOS'], ['77310-FFC', 'Fuel Filler Cap', 'NOS'],
  ['87910-MRA', 'Outer Mirror Assembly RH', 'NOS'], ['55311-DIP', 'Dashboard Insert Panel', 'NOS'],
  ['74410-BTR', 'Battery Tray', 'NOS'], ['76621-MFS', 'Mudflap Set (4 pc)', 'SET'],
  ['81110-HLA', 'Headlamp Assembly RH', 'NOS'], ['67310-DTP', 'Door Trim Panel Front LH', 'NOS'],
  ['11320-DCH', 'Diecast Timing Housing', 'NOS'], ['56101-WSG', 'Windshield Glass Laminated', 'NOS'],
  ['87103-HVB', 'HVAC Blower Unit', 'NOS'], ['EV301-BMS', 'Battery Module Strap', 'NOS'],
  ['EV412-CCB', 'Cell Cooling Bracket', 'NOS'], ['EV220-HVC', 'HV Cable Assembly', 'NOS'],
  ['EV118-CTP', 'Center Tunnel Panel', 'NOS'], ['EV509-SEA', 'Seal Kit Battery Lid', 'SET'],
  ['EV610-INV', 'Inverter Housing Diecast', 'NOS'], ['EV333-FSN', 'Fastener Kit M6 SS', 'SET'],
];

/** Builds the GRN lines exactly as the prototype's buildGrn() does. */
function buildGrnLines() {
  const lines = [];
  let ln = 1;
  const mk = (batch, invPrefix, invCount, dateStr, shift) => {
    let pi = 0;
    for (let i = 1; i <= invCount; i++) {
      const inv = `${invPrefix}${pad(i, 3)}`;
      const nParts = ri(2, 5);
      for (let j = 0; j < nParts && pi < PARTS_POOL.length; j++, pi++) {
        const p = PARTS_POOL[pi];
        lines.push({
          id: 'L' + pad(ln++, 4), batch, shift, inv, part: p[0], desc: p[1], uom: p[2],
          qty: ri(4, 40) * 10, vendor: pick(VENDORS), grnDate: dateStr,
        });
      }
    }
  };
  mk('GRN-0909-01', 'INV-77', 7, '2026-09-09', 'A-2026-09-09');
  _seed = 777; // the prototype re-seeds so the second day is deterministic too
  mk('GRN-0908-01', 'INV-76', 6, '2026-09-08', 'A-2026-09-08');
  return lines;
}

const CONFIG_ROWS = {
  threshold: 50,
  hourly: 60,
  refresh: 60,
  emails: ['rajesh.menon@vistarlogitek.com', 'spd.shiftreport@vistarlogitek.com'],
  labelTpl: 'SPD Standard 100×60',
  grnCols: ['Invoice No.', 'Part Number', 'Part Description', 'GRN Quantity', 'UOM', 'Vendor', 'GRN Date'],
};

/* Demo credentials. Documented in the README — the first thing a real
   deployment does is change them through the Admin console. */
const DEMO_PASSWORD = 'vistar@2026';
const memberPin = (emp) => emp.slice(-4);

async function seed({ reset = false } = {}) {
  await migrate();

  if (reset) {
    await pool.query(`TRUNCATE audit_log, mis_snapshots, hourly_reports, exceptions, packing_txns,
                               labels_printed, allocations, grn_lines, grn_batches, shifts,
                               packing_tables, app_config, users RESTART IDENTITY CASCADE`);
    console.log('[seed] operational tables truncated');
  }

  const existing = await get('SELECT COUNT(*)::int AS n FROM users');
  if (existing.n > 0 && !reset) {
    console.log(`[seed] database already has ${existing.n} users — nothing to do (use --reset to rebuild)`);
    await pool.end();
    return;
  }

  const pwHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const lines = buildGrnLines();

  // Transaction, exception and allocation ids are assigned in one pass here so
  // the numbering matches the prototype's TX0101.., EX011.., AL051...
  let txSeq = 100;
  let excSeq = 10;
  let alSeq = 50;
  const txns = [];
  const exceptions = [];
  const allocs = [];
  const audits = [];

  const cfgThreshold = CONFIG_ROWS.threshold;
  const nf = (n) => Number(n).toLocaleString('en-IN');
  const lineOf = (id) => lines.find((l) => l.id === id);
  const packedOf = (id) => txns.filter((t) => t.line === id && t.status !== 'Started').reduce((s, t) => s + t.qty, 0);

  const startTx = (lid, member, table, when) => {
    const t = { id: 'TX' + pad(++txSeq, 4), line: lid, table, member, startTs: when, submitTs: null, qty: 0, pouches: 0, boxes: 0, status: 'Started' };
    txns.push(t);
    return t;
  };
  const submitTx = (t, qty, pouches, boxes, when) => {
    const l = lineOf(t.line);
    t.qty = qty; t.pouches = pouches || 0; t.boxes = boxes || 0;
    t.submitTs = when; t.status = 'Submitted';
    const cum = packedOf(t.line);
    let exc = null;
    if (cum > l.qty) {
      exc = { id: 'EX' + pad(++excSeq, 3), txn: t.id, line: t.line, type: 'Excess Entry',
        detail: `Cumulative packed ${nf(cum)} exceeds GRN quantity ${nf(l.qty)} for ${l.part} (${l.inv}).`, ts: when };
    } else if (qty > l.qty * cfgThreshold / 100 && qty < l.qty) {
      exc = { id: 'EX' + pad(++excSeq, 3), txn: t.id, line: t.line, type: 'Abnormal Entry',
        detail: `Single submission of ${nf(qty)} is above the ${cfgThreshold}% abnormal-entry threshold of GRN qty ${nf(l.qty)} (${l.part}).`, ts: when };
    }
    if (exc) { exceptions.push(exc); t.status = 'Exception'; }
    const mins = Math.floor((when - t.startTs) / 60000);
    audits.push({ ts: when, actor: t.member, act: 'Packing Submit', ref: l.part,
      detail: `${l.inv} · qty ${nf(qty)} · ${t.pouches} pouches · ${t.boxes} boxes · ${t.table} · ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}`,
      before: 'Started', after: t.status });
    return exc;
  };

  /* ---- the prototype's seed(): today's shift --------------------------- */
  const base = (h, m) => new Date(2026, 8, 9, h, m, ri(0, 59));
  const todays = lines.filter((l) => l.shift === 'A-2026-09-09');
  const order = [...todays];
  const tables6 = TABLES.slice(0, 6);

  for (let i = 0; i < 17; i++) {
    const l = order[i];
    const tb = tables6[i % 6];
    allocs.push({ id: 'AL' + pad(++alSeq, 3), line: l.id, table: tb.no, qty: null, reason: '', ts: base(8, 40 + Math.floor(i / 3)), by: 'sup.rmenon' });
  }
  // BR-04 — the deliberate split, carrying its reason.
  const spl = order[17];
  const splitReason = 'Quantity split — bulky line, two tables to meet dispatch cut-off';
  allocs.push({ id: 'AL' + pad(++alSeq, 3), line: spl.id, table: 'T-07', qty: Math.round(spl.qty / 2), reason: splitReason, ts: base(9, 5), by: 'sup.rmenon' });
  allocs.push({ id: 'AL' + pad(++alSeq, 3), line: spl.id, table: 'T-01', qty: Math.ceil(spl.qty / 2), reason: splitReason, ts: base(9, 5), by: 'sup.rmenon' });

  const labelPrints = [...new Set(allocs.map((a) => a.line))].map((lid, i) => ({
    line: lid, copies: 1, ts: base(8, 25 + (i % 20)), by: 'sup.rmenon', reason: '',
  }));

  const doTx = (lid, table, member, h, m, frac, pou, box, durMin) => {
    const st = base(h, m);
    const t = startTx(lid, member, table, st);
    const l = lineOf(lid);
    const qty = Math.max(10, Math.round(l.qty * frac / 10) * 10);
    submitTx(t, Math.min(qty, l.qty), pou, box, new Date(st.getTime() + durMin * 60000));
  };

  doTx(order[0].id, 'T-01', 'tm.ssingh', 9, 12, 1.0, 12, 3, 38);
  doTx(order[1].id, 'T-02', 'tm.pnair', 9, 18, 1.0, 9, 2, 41);
  doTx(order[2].id, 'T-03', 'tm.mfarooq', 9, 25, 0.6, 6, 2, 30);
  doTx(order[2].id, 'T-03', 'tm.mfarooq', 10, 10, 0.4, 4, 1, 24);   // FR-6.5 partial
  doTx(order[3].id, 'T-04', 'tm.lthomas', 9, 30, 1.0, 10, 3, 47);
  doTx(order[4].id, 'T-05', 'tm.avarma', 9, 40, 1.0, 8, 2, 33);
  doTx(order[5].id, 'T-06', 'tm.gk', 9, 48, 1.0, 14, 4, 52);
  doTx(order[6].id, 'T-01', 'tm.ssingh', 10, 5, 0.4, 5, 1, 26);
  doTx(order[7].id, 'T-02', 'tm.pnair', 10, 12, 0.3, 3, 1, 22);
  doTx(order[8].id, 'T-03', 'tm.mfarooq', 11, 2, 0.5, 5, 2, 35);
  doTx(order[9].id, 'T-04', 'tm.lthomas', 11, 10, 0.45, 4, 1, 28);
  // The over-pack that produces the Excess Entry the Review screen must handle.
  {
    const lid = order[10].id;
    const l = lineOf(lid);
    const st = base(11, 20);
    const t = startTx(lid, 'tm.avarma', 'T-05', st);
    submitTx(t, l.qty + 20, 6, 2, new Date(st.getTime() + 31 * 60000));
  }
  // One transaction left running, so the member screen has something to resume.
  startTx(order[11].id, 'tm.gk', 'T-06', base(11, 48));

  const hourly = [[10, 0], [11, 0], [12, 0]].map((hm, i) => ({
    id: 'HR-' + pad(i + 1, 2), shift: 'A-2026-09-09', at: base(hm[0], hm[1]),
    packed: [1560, 2480, 3140][i], pending: [4820, 3900, 3240][i],
    tables: 'T-01–T-06 occupied', exc: i < 2 ? 0 : 1,
  }));

  /* ---- the previous day: a finalised shift with its MIS ---------------- */
  const yesterday = lines.filter((l) => l.shift === 'A-2026-09-08');
  yesterday.forEach((l, i) => {
    const tb = TABLES[i % 6].no;
    const mem = TABLES[i % 6].member;
    const st = new Date(2026, 8, 8, 9 + (i % 6), (i * 7) % 55, 20);
    const t = startTx(l.id, mem, tb, st);
    submitTx(t, l.qty, ri(4, 12), ri(1, 4), new Date(st.getTime() + ri(20, 50) * 60000));
  });

  audits.push(
    { ts: new Date(2026, 8, 9, 8, 12, 40), actor: 'sup.rmenon', act: 'GRN Import', ref: 'GRN-0909-01',
      detail: 'GRN_SAP_EXPORT_09SEP_S1.xlsx · 24 rows validated & imported · 0 rejected', before: '—', after: '24 lines' },
    { ts: new Date(2026, 8, 8, 17, 42, 10), actor: 'sup.rmenon', act: 'Final Submission', ref: 'A-2026-09-08',
      detail: 'Shift status verified and submitted — member entry locked, MIS generated', before: 'Open', after: 'Finalised' },
    { ts: new Date(2026, 8, 8, 18, 5, 2), actor: 'sup.rmenon', act: 'Resubmission', ref: 'A-2026-09-08',
      detail: 'Shift reopened to correct T-04 boxes count, then resubmitted (logged per BR-06)', before: 'Finalised', after: 'Finalised (rev 2)' },
  );

  /* ---- write it all in one transaction --------------------------------- */
  await tx(async (q) => {
    for (const u of USERS) {
      await q(
        `INSERT INTO users (id, name, emp_code, role, email, device, password_hash, pin_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.id, u.name, u.emp, u.role, u.email, u.device, pwHash,
          u.role === 'Member' ? await bcrypt.hash(memberPin(u.emp), 10) : null],
      );
    }
    for (const [i, t] of TABLES.entries()) {
      await q('INSERT INTO packing_tables (table_no, member_id, sort_order) VALUES ($1,$2,$3)', [t.no, t.member, i]);
    }
    for (const s of SHIFTS) {
      await q('INSERT INTO shifts (id, label, shift_date, status, final_by, final_at, resubmits) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [s.id, s.lbl, s.date, s.status, s.finalBy, s.finalTs, s.resubmits]);
    }
    for (const b of BATCHES) {
      const rows = lines.filter((l) => l.batch === b.id).length;
      await q(`INSERT INTO grn_batches (id, file_name, shift_id, uploaded_at, uploaded_by, row_count, rejected_count, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'Imported')`,
        [b.id, b.file, b.shift, b.ts, b.by, rows, b.rejected]);
    }
    for (const l of lines) {
      await q(`INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, part_desc, uom, grn_qty, vendor, grn_date)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [l.id, l.batch, l.shift, l.inv, l.part, l.desc, l.uom, l.qty, l.vendor, l.grnDate]);
    }
    for (const a of allocs) {
      await q('INSERT INTO allocations (id, line_id, table_no, qty, reason, allocated_at, allocated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [a.id, a.line, a.table, a.qty, a.reason, a.ts, a.by]);
    }
    for (const p of labelPrints) {
      await q('INSERT INTO labels_printed (line_id, copies, printed_at, printed_by, reason) VALUES ($1,$2,$3,$4,$5)',
        [p.line, p.copies, p.ts, p.by, p.reason]);
    }
    for (const t of txns) {
      await q(`INSERT INTO packing_txns (id, line_id, table_no, member_id, start_at, submit_at, qty, pouches, boxes, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.id, t.line, t.table, t.member, t.startTs, t.submitTs, t.qty, t.pouches, t.boxes, t.status]);
    }
    for (const e of exceptions) {
      await q('INSERT INTO exceptions (id, txn_id, line_id, type, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [e.id, e.txn, e.line, e.type, e.detail, e.ts]);
    }
    for (const h of hourly) {
      await q(`INSERT INTO hourly_reports (id, shift_id, generated_at, packed_qty, pending_qty, tables_summary,
                                           exceptions_count, emailed_to, email_status, body_json)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Sent (seeded)','{}'::jsonb)`,
        [h.id, h.shift, h.at, h.packed, h.pending, h.tables, h.exc, CONFIG_ROWS.emails.join(', ')]);
    }

    // MIS for the finalised previous day.
    const yTx = txns.filter((t) => yesterday.some((l) => l.id === t.line) && t.status !== 'Started');
    const yPacked = yTx.reduce((s, t) => s + t.qty, 0);
    const yGrn = yesterday.reduce((s, l) => s + l.qty, 0);
    await q(`INSERT INTO mis_snapshots (id, shift_id, generated_at, lines_packed, pouches, boxes, packed_qty, pending_qty, provisional)
             VALUES ('MIS-0908','A-2026-09-08',$1,$2,$3,$4,$5,$6,FALSE)`,
      [SHIFTS[1].finalTs, yesterday.length,
        yTx.reduce((s, t) => s + t.pouches, 0), yTx.reduce((s, t) => s + t.boxes, 0),
        yPacked, yGrn - yPacked]);

    for (const c of Object.entries(CONFIG_ROWS)) {
      await q(`INSERT INTO app_config (key, value, updated_by) VALUES ($1, $2::jsonb, 'adm.itcell')`, [c[0], JSON.stringify(c[1])]);
    }

    audits.sort((a, b) => a.ts - b.ts);
    for (const a of audits) {
      await q('INSERT INTO audit_log (at, actor_id, action, reference, detail, before_value, after_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [a.ts, a.actor, a.act, a.ref, a.detail, a.before, a.after]);
    }
  });

  console.log(`[seed] ${USERS.length} users · ${TABLES.length} tables · ${lines.length} GRN lines · ${allocs.length} allocations · ${txns.length} transactions · ${exceptions.length} exception(s)`);
  console.log(`[seed] sign in as sup.rmenon / ${DEMO_PASSWORD} — table members use the same password, or the last 4 digits of their employee code as a PIN`);
  await pool.end();
}

seed({ reset: process.argv.includes('--reset') }).catch(async (err) => {
  console.error('[seed] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
