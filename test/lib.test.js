import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { lineStatus } from '../src/lib/compute.js';
import { previewSubmission } from '../src/lib/packing.js';
import { pad, lineId, nextId, nextBatchId } from '../src/lib/ids.js';
import { DEFAULTS } from '../src/lib/settings.js';
import { parseGrnFile } from '../src/services/grnImport.js';
import { buildCsv, buildWorkbook } from '../src/services/excelExport.js';
import { hourlyReportHtml } from '../src/services/mailer.js';

/* ============================================================================
   The pure logic of lib/ and services/. The smoke test drives these through
   HTTP, which proves the happy path works but says nothing about the branches
   a shift only reaches occasionally — a malformed GRN row, a quantity exactly
   on the threshold, a CSV value containing a quote.
   ========================================================================== */

/* ---- compute.lineStatus: the precedence in SRS section 10 --------------- */

test('line status follows its precedence: exception, then complete, then progress', () => {
  const base = { grn_qty: 100, packed: 0, open_exceptions: 0, running: 0, allocations: 0 };

  assert.equal(lineStatus({ ...base }), 'Pending');
  assert.equal(lineStatus({ ...base, allocations: 1 }), 'Allocated');
  assert.equal(lineStatus({ ...base, allocations: 1, running: 1 }), 'In Progress');
  assert.equal(lineStatus({ ...base, allocations: 1, packed: 40 }), 'In Progress');
  assert.equal(lineStatus({ ...base, allocations: 1, packed: 100 }), 'Completed');
  assert.equal(lineStatus({ ...base, allocations: 1, packed: 120 }), 'Completed');

  // an open exception outranks everything, including a fully packed line
  assert.equal(lineStatus({ ...base, allocations: 1, packed: 100, open_exceptions: 1 }), 'Exception');
  assert.equal(lineStatus({ ...base, open_exceptions: 1 }), 'Exception');
});

test('line status copes with the strings a driver can hand back', () => {
  // NUMERIC arrives as a string from some drivers; the status must not flip.
  assert.equal(lineStatus({ grn_qty: '100', packed: '100', open_exceptions: '0', running: '0', allocations: '1' }), 'Completed');
});

/* ---- packing.previewSubmission: FR-7.2 thresholds ----------------------- */

test('the submission hint matches the rule that will actually flag it', async () => {
  const at = (qty, packed = 0) => previewSubmission({ grnQty: 100, packed, qty, threshold: 50 });

  assert.equal((await at(40)).tone, 'ok');
  assert.equal((await at(50)).tone, 'ok', 'exactly at the threshold is not above it');
  assert.equal((await at(51)).tone, 'warn', 'above the threshold warns');
  assert.equal((await at(100)).tone, 'warn', 'a full-quantity submission is still only a warning');
  assert.equal((await at(101)).tone, 'bad', 'over GRN is an excess entry');
  assert.equal((await at(60, 50)).tone, 'bad', 'cumulative over GRN is an excess entry');

  const ok = await at(40);
  assert.match(ok.message, /Pending after submit: 60/);
  const bad = await at(101);
  assert.match(bad.message, /BR-03/);
});

/* ---- ids ---------------------------------------------------------------- */

test('id helpers produce the series the screens display', async () => {
  assert.equal(pad(7, 4), '0007');
  assert.equal(lineId(1), 'L0001');
  assert.equal(lineId(1234), 'L1234');

  const q = async () => [{ id: 'TX0107' }];
  assert.equal(await nextId('packing_txns', 'TX', 4, q), 'TX0108');

  const empty = async () => [];
  assert.equal(await nextId('packing_txns', 'TX', 4, empty), 'TX0001');

  // GRN batches read as GRN-DDMM-NN, from the shift date not today's date
  assert.equal(await nextBatchId('2026-09-09', async () => []), 'GRN-0909-01');
  assert.equal(await nextBatchId('2026-09-09', async () => [{ id: 'GRN-0909-01' }]), 'GRN-0909-02');
});

/* ---- settings ----------------------------------------------------------- */

test('the shipped defaults are the ones the approved prototype used', () => {
  assert.equal(DEFAULTS.threshold, 50);
  assert.equal(DEFAULTS.hourly, 60);
  assert.equal(DEFAULTS.refresh, 60);
  assert.equal(DEFAULTS.grnCols.length, 7);
  assert.ok(DEFAULTS.grnCols.includes('GRN Quantity'));
  assert.ok(DEFAULTS.emails.every((e) => e.includes('@')));
});

/* ---- grnImport: FR-1.2 / FR-1.3 ---------------------------------------- */

const HEADER = 'Invoice No.,Part Number,Part Description,GRN Quantity,UOM,Vendor,GRN Date';
const parse = (csv, opts = {}) => parseGrnFile({
  buffer: Buffer.from(csv, 'utf8'),
  filename: 'GRN.csv',
  requiredCols: DEFAULTS.grnCols,
  defaultGrnDate: '2026-09-09',
  ...opts,
});

test('a clean file imports every row', async () => {
  const { rows, errors } = await parse([
    HEADER,
    'INV-1,90210-ABX,Bracket LH,270,NOS,DynaFast,09-Sep-2026',
    'INV-1,90211-ABX,Bracket RH,340,NOS,Precision,09-Sep-2026',
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].grn_qty, 270);
  assert.equal(rows[0].grn_date, '2026-09-09');
  assert.equal(rows[0].part_no, '90210-ABX');
});

test('every bad row is named with its row number and column', async () => {
  const { rows, errors } = await parse([
    HEADER,
    'INV-1,SMOKE-001,Blank quantity,,NOS,V,09-Sep-2026',
    'INV-1,SM 01,Space in part number,120,NOS,V,09-Sep-2026',
    'INV-2,SMOKE-002,Negative,-40,NOS,V,09-Sep-2026',
    'INV-2,SMOKE-003,Not a number,abc,NOS,V,09-Sep-2026',
    ',SMOKE-004,Blank invoice,50,NOS,V,09-Sep-2026',
    'INV-2,SMOKE-005,Good,150,NOS,V,09-Sep-2026',
  ].join('\n'));

  assert.equal(rows.length, 1, 'only the good row imports');
  assert.equal(errors.length, 5);
  // the row numbers are the ones the supervisor sees in Excel
  assert.deepEqual(errors.map((e) => e.row), [2, 3, 4, 5, 6]);
  assert.equal(errors[0].column, 'GRN Quantity');
  assert.equal(errors[1].column, 'Part Number');
  assert.match(errors[2].error, /greater than zero/);
  assert.match(errors[3].error, /Not a number/);
  assert.equal(errors[4].column, 'Invoice No.');
});

test('a duplicate inside one file is caught, pointing at the first occurrence', async () => {
  const { rows, errors } = await parse([
    HEADER,
    'INV-1,90210-ABX,First,270,NOS,V,09-Sep-2026',
    'INV-1,90210-ABX,Same invoice and part,270,NOS,V,09-Sep-2026',
  ].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /Duplicate of row 2/);
});

test('the header is found even when SAP puts a title above it', async () => {
  const { rows, errors } = await parse([
    'GRN REPORT — SHIFT A',
    '',
    HEADER,
    'INV-1,90210-ABX,Bracket,270,NOS,V,09-Sep-2026',
  ].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 0);
});

test('a missing required column stops the import before a single row is read', async () => {
  await assert.rejects(
    () => parse(['Invoice No.,Part Number,Part Description,UOM,Vendor,GRN Date',
      'INV-1,90210-ABX,Bracket,NOS,V,09-Sep-2026'].join('\n')),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /GRN Quantity/);
      assert.ok(err.details.some((d) => d.row === 'header'));
      return true;
    },
  );
});

test('a file with no recognisable header is rejected as a whole', async () => {
  await assert.rejects(() => parse('a,b,c\n1,2,3'), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /No GRN header row/);
    return true;
  });
});

test('the date formats SAP exports all resolve to the same day', async () => {
  for (const d of ['09-Sep-2026', '09/09/2026', '09-09-2026', '2026-09-09']) {
    const { rows, errors } = await parse([HEADER, `INV-1,PART-1,x,10,NOS,V,${d}`].join('\n'));
    assert.equal(errors.length, 0, `${d} produced errors`);
    assert.equal(rows[0].grn_date, '2026-09-09', `${d} parsed wrong`);
  }
});

test('a missing date falls back to the shift date rather than failing the row', async () => {
  const { rows, errors } = await parse([HEADER, 'INV-1,PART-1,x,10,NOS,V,'].join('\n'));
  assert.equal(errors.length, 0);
  assert.equal(rows[0].grn_date, '2026-09-09');
});

test('quantities with thousands separators import as numbers', async () => {
  const { rows } = await parse([HEADER, '"INV-1",PART-1,x,"1,250",NOS,V,09-Sep-2026'].join('\n'));
  assert.equal(rows[0].grn_qty, 1250);
});

test('an xlsx export imports the same as the equivalent csv', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('GRN');
  ws.addRow(HEADER.split(','));
  ws.addRow(['INV-1', '90210-ABX', 'Bracket LH', 270, 'NOS', 'DynaFast', new Date(Date.UTC(2026, 8, 9))]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  const { rows, errors } = await parseGrnFile({
    buffer, filename: 'GRN.xlsx', requiredCols: DEFAULTS.grnCols, defaultGrnDate: '2026-09-09',
  });
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grn_qty, 270);
  assert.equal(rows[0].grn_date, '2026-09-09');
});

test('an empty file is rejected rather than importing nothing in silence', async () => {
  await assert.rejects(() => parse(''), (err) => {
    assert.match(err.message, /empty/);
    return true;
  });
});

/* ---- excelExport -------------------------------------------------------- */

test('csv quotes every field and escapes embedded quotes', () => {
  const csv = buildCsv({
    cols: ['Part', 'Detail'],
    rows: [['90210-ABX', 'a "quoted" value, with a comma'], [null, undefined]],
  }).toString('utf8');

  assert.ok(csv.startsWith('﻿'), 'a BOM so Excel opens it as UTF-8');
  const lines = csv.replace('﻿', '').split('\r\n');
  assert.equal(lines[0], '"Part","Detail"');
  assert.equal(lines[1], '"90210-ABX","a ""quoted"" value, with a comma"');
  assert.equal(lines[2], '"",""', 'null and undefined become empty, not the word null');
});

test('the workbook is a real xlsx carrying the grouped header', async () => {
  const buf = await buildWorkbook({
    title: 'SPD MIS',
    groups: [{ t: 'SHIFT', n: 2 }, { t: 'METRICS', n: 2 }],
    cols: ['Date', 'Txn', 'Qty', 'Boxes'],
    rows: [['09-Sep-2026', 'TX0101', 270, 3]],
  });
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'a zip, which is what xlsx is');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.getRow(1).getCell(1).value, 'SHIFT');
  assert.equal(ws.getRow(2).getCell(1).value, 'Date');
  assert.equal(ws.getRow(3).getCell(3).value, 270, 'quantities stay numbers, not text');
});

/* ---- mailer ------------------------------------------------------------- */

test('the hourly email states the figures the SRS asks it to', () => {
  const html = hourlyReportHtml({
    shiftLabel: 'Shift A · 09-Sep-2026',
    at: Date.UTC(2026, 8, 9, 6, 30),
    packed: 3140, pending: 3240, tables: '6 occupied', exceptions: 1,
    members: [{ name: 'Sandeep Singh', qty: 330, lines: 2 }],
  });
  assert.match(html, /3,140/, 'packed quantity, grouped');
  assert.match(html, /3,240/, 'pending quantity');
  assert.match(html, /6 occupied/);
  assert.match(html, /Sandeep Singh/);
  assert.match(html, /Shift A/);
});

test('the hourly email renders with no submissions yet', () => {
  const html = hourlyReportHtml({
    shiftLabel: 'Shift A', at: Date.now(), packed: 0, pending: 0,
    tables: '0 occupied', exceptions: 0, members: [],
  });
  assert.match(html, /—/, 'an em dash rather than an empty member list');
});
