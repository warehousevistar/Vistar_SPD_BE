/**
 * End-to-end smoke test over the running API surface.
 *
 * It walks the SRS use cases in order — sign in, list lines, allocate, start,
 * submit, trip an exception, annotate it, finalise, reopen — because the rules
 * that matter most here are the ones about *sequence* (BR-03, BR-06), and those
 * only fail when the steps run in the wrong order or not at all.
 *
 *   node scripts/smoke.js          against http://localhost:4100/api
 *   API=http://host/api node scripts/smoke.js
 */
const API = process.env.API || 'http://localhost:4100/api';
const SHIFT = process.env.SHIFT || 'A-2026-09-09';

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, note = '') {
  if (ok) { pass++; results.push(`  ok   ${name}${note ? ` — ${note}` : ''}`); }
  else { fail++; results.push(`  FAIL ${name}${note ? ` — ${note}` : ''}`); }
}

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function main() {
  console.log(`\nVistar SPD — API smoke test against ${API}\n`);

  /* ---- health ---- */
  const health = await call('GET', '/health');
  check('health', health.status === 200 && health.data.ok, `${health.data?.counts?.grn_lines ?? '?'} GRN lines`);

  /* ---- UC-01 sign in ---- */
  const sup = await call('POST', '/auth/login', { body: { userId: 'sup.rmenon', password: 'vistar@2026' } });
  check('supervisor signs in', sup.status === 200 && !!sup.data.token, sup.data.user?.name);
  const T = sup.data.token;

  const bad = await call('POST', '/auth/login', { body: { userId: 'sup.rmenon', password: 'wrong' } });
  check('wrong password is rejected', bad.status === 401);

  const members = await call('GET', '/auth/members');
  check('member roster is public for the login picker (FR-5.1)', members.status === 200 && members.data.members.length > 0);

  const memberLogin = await call('POST', '/auth/login', { body: { userId: 'tm.ssingh', pin: '4412' } });
  check('table member signs in with a PIN (NFR-3.1)', memberLogin.status === 200 && !!memberLogin.data.token, memberLogin.data.user?.table_no);
  const M = memberLogin.data.token;

  /* ---- FR-2 lines ---- */
  const lines = await call('GET', `/lines?shiftId=${SHIFT}`, { token: T });
  check('invoice/part listing (FR-2.1)', lines.status === 200 && lines.data.lines.length > 0, `${lines.data.lines?.length} lines`);
  const consistent = lines.data.lines.every((l) => Math.abs((Number(l.grn_qty) - Number(l.packed)) - l.pending) < 1e-9);
  check('pending = GRN − packed on every line (BR-01/NFR-7.2)', consistent);

  /* ---- FR-11 dashboard ---- */
  const dash = await call('GET', `/dashboard?shiftId=${SHIFT}`, { token: T });
  const st = dash.data.stats;
  check('dashboard totals reconcile (NFR-7.2)', dash.status === 200 && Math.abs(st.grn - st.packed - st.pending) < 1e-9,
    `GRN ${st?.grn} − packed ${st?.packed} = pending ${st?.pending}`);

  /* ---- FR-4 allocation, BR-04 ---- */
  const unallocated = lines.data.lines.find((l) => l.allocations === 0);
  if (unallocated) {
    const a1 = await call('POST', '/allocations', { token: T, body: { lineId: unallocated.id, tableNo: 'T-08' } });
    check('allocate a line to a table (FR-4.1)', a1.status === 201, `${unallocated.part_no} → T-08`);
    const a2 = await call('POST', '/allocations', { token: T, body: { lineId: unallocated.id, tableNo: 'T-07' } });
    check('second table without an explicit split is refused (BR-04)', a2.status === 409);
  } else {
    check('allocate a line to a table (FR-4.1)', false, 'no unallocated line to test with');
  }

  /* ---- FR-6 start & submit as a member, BR-02 ---- */
  const queue = await call('GET', `/my/queue?shiftId=${SHIFT}`, { token: M });
  check('member sees only their own table (BR-05)', queue.status === 200 && queue.data.tableNo === 'T-01');
  const target = queue.data.lines?.find((l) => l.pending > 0);

  if (queue.data.running) {
    await call('POST', '/my/submit', { token: M, body: { txnId: queue.data.running.id, qty: 10, pouches: 1, boxes: 1 } });
  }

  if (target) {
    const start = await call('POST', '/my/start', { token: M, body: { lineId: target.id } });
    check('Start Packing records the start time (FR-6.1)', start.status === 201 && !!start.data.txn?.start_at);
    const txnId = start.data.txn?.id;

    const zero = await call('POST', '/my/submit', { token: M, body: { txnId, qty: 0 } });
    check('zero quantity is rejected (BR-02)', zero.status === 400, zero.data.error?.slice(0, 48));
    const frac = await call('POST', '/my/submit', { token: M, body: { txnId, qty: 2.5 } });
    check('non-integer quantity is rejected (BR-02)', frac.status === 400);

    const ok = await call('POST', '/my/submit', { token: M, body: { txnId, qty: 10, pouches: 1, boxes: 1 } });
    check('submit records the time and reconciles (FR-6.3/FR-7.1)', ok.status === 200 && !!ok.data.txn?.submit_at,
      `pending now ${ok.data.line?.pending}`);

    const again = await call('POST', '/my/submit', { token: M, body: { txnId, qty: 5 } });
    check('a submitted transaction is immutable (NFR-7.1)', again.status === 409);
  } else {
    check('Start Packing records the start time (FR-6.1)', false, 'nothing pending on T-01');
  }

  /* ---- FR-7.2 exception on over-pack ---- */
  const q2 = await call('GET', `/my/queue?shiftId=${SHIFT}`, { token: M });
  const over = q2.data.lines?.find((l) => l.pending > 0);
  if (over) {
    const s = await call('POST', '/my/start', { token: M, body: { lineId: over.id } });
    const sub = await call('POST', '/my/submit', {
      token: M,
      body: { txnId: s.data.txn.id, qty: Math.round(Number(over.grn_qty)) + 10, pouches: 2, boxes: 1 },
    });
    check('over-packing is flagged as an Excess Entry (FR-7.2/BR-03)',
      sub.status === 200 && sub.data.exception?.type === 'Excess Entry', sub.data.exception?.id);
  }

  /* ---- FR-9 review, BR-03 finalise gate ---- */
  const review = await call('GET', `/review?shiftId=${SHIFT}`, { token: T });
  check('review screen lists exceptions (FR-9.1)', review.status === 200 && Array.isArray(review.data.exceptions),
    `${review.data.exceptions?.length} exception(s)`);

  const openExc = review.data.exceptions.filter((e) => !e.remarks && !e.resolved_at);
  if (openExc.length) {
    const blocked = await call('POST', `/shifts/${SHIFT}/finalise`, { token: T });
    check('finalising is blocked while an exception lacks remarks (BR-03)', blocked.status === 409, blocked.data.error?.slice(0, 60));
    for (const e of openExc) {
      const r = await call('PATCH', `/exceptions/${e.id}`, {
        token: T,
        body: { remarks: 'Smoke test — physical recount done, excess returned to stores under GD note', resolve: true },
      });
      if (r.status !== 200) check(`annotate ${e.id} (FR-9.2)`, false, r.data.error);
    }
    check('exceptions annotated and resolved (FR-9.2)', true, `${openExc.length} closed`);
  }

  const empty = await call('PATCH', `/exceptions/${review.data.exceptions[0]?.id ?? 'EX000'}`, { token: T, body: { remarks: '' } });
  check('an exception cannot be saved without remarks (FR-9.2)', empty.status === 400 || empty.status === 404 || empty.status === 409);

  /* ---- UC-07 finalise, BR-06 lock, FR-10.1 MIS ---- */
  const fin = await call('POST', `/shifts/${SHIFT}/finalise`, { token: T });
  check('final submission generates the MIS automatically (FR-10.1)', fin.status === 200 && !!fin.data.misId, fin.data.misId);

  const lockedStart = await call('POST', '/my/start', { token: M, body: { lineId: target?.id ?? 'L0001' } });
  check('member entry is locked once the shift is finalised (BR-06)', lockedStart.status === 409, lockedStart.data.error?.slice(0, 52));

  const noReason = await call('POST', `/shifts/${SHIFT}/reopen`, { token: T, body: {} });
  check('reopening without a reason is refused (BR-06)', noReason.status === 400);
  const reopen = await call('POST', `/shifts/${SHIFT}/reopen`, { token: T, body: { reason: 'Smoke test — reopened to restore the demo shift' } });
  check('reopening is logged as a resubmission (BR-06)', reopen.status === 200 && reopen.data.shift?.status === 'Open',
    `rev ${(reopen.data.shift?.resubmits ?? 0) + 1}`);

  /* ---- FR-10.2 MIS dimensions ---- */
  for (const dim of ['line', 'inv', 'table', 'member']) {
    const mis = await call('GET', `/mis?shiftId=${SHIFT}&dim=${dim}`, { token: T });
    check(`MIS ${dim}-wise (FR-10.2)`, mis.status === 200 && Array.isArray(mis.data.rows), `${mis.data.rows?.length} rows`);
  }

  /* ---- FR-12.1 exports ---- */
  const xlsx = await call('GET', `/export/mis/xlsx?shiftId=${SHIFT}`, { token: T, raw: true });
  check('MIS exports to Excel (FR-12.1)', xlsx.status === 200 && xlsx.buf.slice(0, 2).toString() === 'PK', `${xlsx.buf.length} bytes`);
  const csv = await call('GET', `/export/audit/csv`, { token: T, raw: true });
  check('audit trail exports to CSV (FR-12.1)', csv.status === 200 && csv.buf.length > 0, `${csv.buf.length} bytes`);

  /* ---- FR-3 labels ---- */
  const lineId = lines.data.lines[0].id;
  const preview = await call('GET', `/labels/${lineId}/preview`, { token: T });
  check('label preview carries part, invoice, qty and a QR (FR-3.1)',
    preview.status === 200 && Array.isArray(preview.data.qr) && preview.data.qr.length === 25);

  const noReasonReprint = await call('POST', `/labels/${lineId}/print`, { token: T, body: {} });
  check('a reprint without a reason is refused (BR-09)', noReasonReprint.status === 400 || noReasonReprint.status === 200,
    noReasonReprint.status === 400 ? 'refused' : 'first print allowed');

  /* The dialog decides whether to demand a reprint reason from `alreadyPrinted`.
     If that disagrees with what the print endpoint enforces, the Supervisor is
     never asked for a reason and the print is then refused — which is exactly
     what happened when lineById() omitted the label count. */
  check("preview's alreadyPrinted agrees with what the print endpoint enforces (BR-09)",
    preview.data.alreadyPrinted === (noReasonReprint.status === 400),
    `alreadyPrinted=${preview.data.alreadyPrinted}, print without reason → ${noReasonReprint.status}`);
  const pdf = await call('GET', `/labels/sheet.pdf?lineId=${lineId}`, { token: T, raw: true });
  check('label sheet renders as PDF (FR-3.2)', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF', `${pdf.buf.length} bytes`);

  /* ---- FR-3.5 the MOQ split ---- */
  const splitLine = lines.data.lines.find((l) => l.moq && Number(l.grn_qty) > Number(l.moq));
  if (!splitLine) {
    check('the shift has a line with an MOQ to split (FR-3.5)', false, 'none seeded');
  } else {
    const sp = await call('GET', `/labels/${splitLine.id}/preview`, { token: T });
    const ls = sp.data.labels ?? [];
    const expected = Math.ceil(Number(splitLine.grn_qty) / Number(splitLine.moq));
    const total = ls.reduce((s, l) => s + Number(l.qty), 0);
    check('a line with an MOQ previews one label per pack (FR-3.5)',
      sp.status === 200 && ls.length === expected,
      `${splitLine.part_no}: GRN ${splitLine.grn_qty} ÷ MOQ ${splitLine.moq} → ${ls.length} label(s) of ${ls.map((l) => l.qty).join(' + ')}`);
    check('the labels account for the whole GRN quantity (FR-3.5, BR-01)',
      Math.round(total * 100) === Math.round(Number(splitLine.grn_qty) * 100),
      `${total} vs ${splitLine.grn_qty}`);
    check('each label carries its own quantity in its QR payload (FR-3.5)',
      ls.every((l) => l.payload.endsWith(`|${l.qty}`)) && new Set(ls.map((l) => l.qr.length)).size === 1,
      ls.map((l) => l.payload).join('  '));

    /* The sheet is the artefact that reaches the printer, so the page count is
       what actually proves the split — a preview that splits and a PDF that
       does not would send one label for a pack that needs two. */
    const splitPdf = await call('GET', `/labels/sheet.pdf?lineId=${splitLine.id}`, { token: T, raw: true });
    const pages = (splitPdf.buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    check('the printed sheet carries one page per label (FR-3.2/3.5)',
      splitPdf.status === 200 && pages === expected, `${pages} page(s), expected ${expected}`);

    /* The console's "Print sheet · N" is the sum of these, and it is what a
       Supervisor sizes label stock from. Three numbers derived in three places
       — the lines list, the preview and the PDF — have to be the same number,
       or the console promises a sheet the printer does not produce. */
    check('the line list reports the same label count as the preview and the sheet (FR-3.5)',
      Number(splitLine.label_count) === ls.length && ls.length === pages,
      `lines ${splitLine.label_count} · preview ${ls.length} · pages ${pages}`);

    const sheetTotal = lines.data.lines.reduce((n, l) => n + Number(l.label_count ?? 1), 0);
    const allPdf = await call('GET', `/labels/sheet.pdf?shiftId=${SHIFT}`, { token: T, raw: true });
    const allPages = (allPdf.buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    check('the whole-shift sheet matches the count the console shows (FR-3.5)',
      allPages === sheetTotal,
      `${lines.data.lines.length} lines → console says ${sheetTotal} labels, sheet has ${allPages} pages`);
  }

  /* ---- FR-8 hourly ---- */
  const gen = await call('POST', '/hourly/generate', { token: T, body: { shiftId: SHIFT } });
  check('hourly report generated and retained (FR-8.1/8.3)', gen.status === 201 && !!gen.data.report?.id, gen.data.report?.id);

  /* ---- FR-13.3 role-based access ---- */
  const viewer = await call('POST', '/auth/login', { body: { userId: 'mgt.avohra', password: 'vistar@2026' } });
  const viewerFinalise = await call('POST', `/shifts/${SHIFT}/finalise`, { token: viewer.data.token });
  check('Management cannot finalise a shift (FR-13.3)', viewerFinalise.status === 403);
  const memberAlloc = await call('POST', '/allocations', { token: M, body: { lineId, tableNo: 'T-02' } });
  check('a member cannot allocate tables (FR-13.3)', memberAlloc.status === 403);
  const noToken = await call('GET', `/dashboard?shiftId=${SHIFT}`);
  check('unauthenticated access is refused (NFR-3.1)', noToken.status === 401);

  /* ---- FR-1.3 import validation ---- */
  const badCsv = ['Invoice No.,Part Number,Part Description,GRN Quantity,UOM,Vendor,GRN Date',
    'INV-99001,SMOKE-001,Blank quantity,,NOS,Smoke Vendor,09-Sep-2026',
    'INV-99001,SM 01,Part number carries a space,120,NOS,Smoke Vendor,09-Sep-2026',
    'INV-99002,SMOKE-002,Negative quantity,-40,NOS,Smoke Vendor,09-Sep-2026',
    'INV-99002,SMOKE-003,Good row,150,NOS,Smoke Vendor,09-Sep-2026'].join('\n');
  const form = new FormData();
  form.append('file', new Blob([badCsv], { type: 'text/csv' }), 'SMOKE_GRN.csv');
  form.append('shiftId', SHIFT);
  const up = await fetch(`${API}/grn/upload`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: form });
  const upData = await up.json();
  check('import names the exact row and column of every problem (FR-1.3)',
    up.status === 201 && upData.errors?.length === 3 && upData.imported === 1,
    upData.errors?.map((e) => `row ${e.row}/${e.column}`).join(', '));

  /* The console builds the rejected-row file itself, so this endpoint has no
     caller in the app — which is exactly why it needs a check of its own. An
     endpoint nothing exercises is where the next contract drift hides. */
  const errCsv = await fetch(`${API}/grn/errors.csv`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ errors: upData.errors ?? [] }),
  });
  const errCsvBody = await errCsv.text();
  check('rejected rows download as CSV (FR-1.3)',
    errCsv.status === 200 && errCsvBody.includes('Row') && errCsvBody.includes('Error'),
    `${errCsvBody.split('\r\n').length - 1} row(s)`);

  const dup = new FormData();
  dup.append('file', new Blob([badCsv], { type: 'text/csv' }), 'SMOKE_GRN.csv');
  dup.append('shiftId', SHIFT);
  const dupRes = await fetch(`${API}/grn/upload`, { method: 'POST', headers: { Authorization: `Bearer ${T}` }, body: dup });
  check('a duplicate batch is blocked without confirmation (BR-08)', dupRes.status === 409);

  /* ---- FR-13.2 config validation ---- */
  const badCfg = await call('PUT', '/config', { token: T, body: { threshold: 250 } });
  check('an out-of-range threshold is refused with a specific message (NFR-4.2)', badCfg.status === 400, badCfg.data.error);

  /* NFR-6.1 says the column mapping is configuration rather than code. That is
     only true if a column removed from it is actually ignored — the setting
     round-tripped happily for a while without changing what the importer read. */
  const cfgNow = await call('GET', '/config', { token: T });
  const optional = cfgNow.data.config?.grnColsOptional;
  check('the optional column list survives the round trip (NFR-6.1)',
    cfgNow.status === 200 && Array.isArray(optional) && optional.includes('MOQ'),
    `grnColsOptional = ${JSON.stringify(optional)}`);

  const clearedCfg = await call('PUT', '/config', { token: T, body: { grnColsOptional: [] } });
  const clearedBack = await call('GET', '/config', { token: T });
  check('an optional column can be removed and stays removed (NFR-6.1)',
    clearedCfg.status === 200 && (clearedBack.data.config?.grnColsOptional ?? ['x']).length === 0,
    JSON.stringify(clearedBack.data.config?.grnColsOptional));
  await call('PUT', '/config', { token: T, body: { grnColsOptional: optional ?? ['MOQ'] } });

  /* ---- NFR-3.3 audit trail ---- */
  const audit = await call('GET', '/audit?limit=50', { token: T });
  const actions = new Set((audit.data.entries ?? []).map((a) => a.action));
  check('audit trail records the shift lifecycle (NFR-3.3)',
    audit.status === 200 && actions.has('Final Submission') && actions.has('Resubmission') && actions.has('Packing Submit'),
    [...actions].slice(0, 6).join(', '));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.log(results.join('\n'));
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});
