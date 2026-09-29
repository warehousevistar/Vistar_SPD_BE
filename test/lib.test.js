import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { lineStatus } from '../src/lib/compute.js';
import { previewSubmission } from '../src/lib/packing.js';
import { pad, lineId, nextId, nextBatchId } from '../src/lib/ids.js';
import { DEFAULTS } from '../src/lib/settings.js';
import { parseGrnFile } from '../src/services/grnImport.js';
import { labelUnits, labelPayload } from '../src/services/labels.js';
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
  optionalCols: DEFAULTS.grnColsOptional,
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

/* ============================================================================
   FR-3.5 — the MOQ label split.

   "If MOQ is 300 and actual is 350, print 300 then again 50 separate." The rule
   is small enough to read at a glance and easy to get subtly wrong at the
   boundaries: an exact multiple must not produce an empty remainder label, an
   MOQ above the quantity must not produce a negative one, and a decimal MOQ
   must not leave floating-point dust in the remainder — which is the label a
   supervisor is least likely to re-check.
   ========================================================================== */

const line = (grn_qty, moq) =>
  ({ part_no: '76621-MFS', invoice_no: 'INV-77001', uom: 'NOS', grn_qty, moq });
const split = (grn_qty, moq) => labelUnits(line(grn_qty, moq)).map((u) => u.label_qty);

test('a line splits into one label per MOQ pack, plus the remainder', () => {
  assert.deepEqual(split(350, 300), [300, 50]);      // the rule as stated
  assert.deepEqual(split(1000, 300), [300, 300, 300, 100]);
  assert.deepEqual(split(360, 100), [100, 100, 100, 60]);
});

test('an exact multiple produces no empty remainder label', () => {
  assert.deepEqual(split(300, 300), [300]);
  assert.deepEqual(split(900, 300), [300, 300, 300]);
  assert.deepEqual(split(100, 50), [50, 50]);
});

test('an MOQ at or above the quantity leaves the line whole', () => {
  assert.deepEqual(split(140, 200), [140]);
  assert.deepEqual(split(140, 140), [140]);
});

test('no MOQ is the FR-3.1 label, exactly as before the rule existed', () => {
  for (const moq of [null, undefined, 0, '', NaN]) {
    assert.deepEqual(split(350, moq), [350], `moq ${String(moq)}`);
  }
});

test('the labels always account for the whole GRN quantity', () => {
  for (const [qty, moq] of [[350, 300], [1000, 300], [360, 100], [7, 2], [100, 33], [10.5, 0.5]]) {
    const parts = split(qty, moq);
    const total = parts.reduce((s, p) => s + p, 0);
    assert.equal(Math.round(total * 100), Math.round(qty * 100),
      `${qty} ÷ ${moq} came to ${total}`);
    assert.ok(parts.every((p) => p > 0), `${qty} ÷ ${moq} produced an empty label`);
    assert.ok(parts.every((p) => p <= moq), `${qty} ÷ ${moq} produced a label above the MOQ`);
  }
});

test('a decimal MOQ divides without leaving floating-point dust', () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point, and the error would land in the
  // remainder. The arithmetic runs in hundredths for this reason.
  assert.deepEqual(split(10.5, 0.5), Array(21).fill(0.5));
  assert.deepEqual(split(1, 0.3), [0.3, 0.3, 0.3, 0.1]);
});

test('every label is numbered, and an unsplit one says 1 of 1', () => {
  const two = labelUnits(line(350, 300));
  assert.deepEqual(two.map((u) => [u.label_index, u.label_of]), [[1, 2], [2, 2]]);
  const one = labelUnits(line(270, null));
  assert.deepEqual(one.map((u) => [u.label_index, u.label_of]), [[1, 1]]);
});

test('a label carries the rest of its line', () => {
  const [first] = labelUnits(line(350, 300));
  assert.equal(first.part_no, '76621-MFS');
  assert.equal(first.invoice_no, 'INV-77001');
  assert.equal(first.grn_qty, 350, 'the line total must survive for FR-3.1');
});

test('the QR payload carries the label quantity, not the line quantity', () => {
  const [a, b] = labelUnits(line(350, 300));
  assert.equal(labelPayload(a), '76621-MFS|INV-77001|300');
  assert.equal(labelPayload(b), '76621-MFS|INV-77001|50');

  // An unsplit line's payload is byte-identical to what it was before MOQ, so
  // codes already printed and scanned keep working.
  assert.equal(labelPayload(labelUnits(line(270, null))[0]), '76621-MFS|INV-77001|270');
});

test('a split payload still fits a version-2 QR, so the code keeps its size', () => {
  /* The encoder grows the symbol to fit rather than truncating, so a longer
     payload is no longer a correctness problem — but a split payload is only a
     few bytes longer than the unsplit one, and staying inside version 2's 26
     bytes means the split prints the same 25×25 code every label has always
     had. labels.test.js is where the encoder's own limits are pinned down. */
  for (const u of labelUnits(line(350, 300))) {
    assert.ok(Buffer.byteLength(labelPayload(u)) <= 26,
      `${labelPayload(u)} is ${Buffer.byteLength(labelPayload(u))} bytes`);
  }
});

/* ---- the import reads MOQ when it is there, and only then --------------- */

const HEADER_MOQ = `${HEADER},MOQ`;

test('MOQ is optional — a file without the column still imports', async () => {
  const { rows, errors } = await parse([
    HEADER,
    'INV-1,90210-ABX,Bracket LH,270,NOS,DynaFast,09-Sep-2026',
  ].join('\n'));
  assert.equal(errors.length, 0);
  assert.equal(rows[0].moq, null, 'a missing column is not a missing value');
});

test('MOQ is read when the column is present, and a blank cell is not an error', async () => {
  const { rows, errors } = await parse([
    HEADER_MOQ,
    'INV-1,76621-MFS,Mount Foot,350,NOS,DynaFast,09-Sep-2026,300',
    'INV-1,90210-ABX,Bracket LH,270,NOS,DynaFast,09-Sep-2026,',
    'INV-1,82111-WHM,Washer,360,NOS,Precision,09-Sep-2026,"1,000"',
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => r.moq), [300, null, 1000]);
});

test('a present but unusable MOQ is rejected by row and column (NFR-4.2)', async () => {
  const { rows, errors } = await parse([
    HEADER_MOQ,
    'INV-1,76621-MFS,Mount Foot,350,NOS,DynaFast,09-Sep-2026,abc',
    'INV-1,90211-ABX,Bracket RH,340,NOS,DynaFast,09-Sep-2026,0',
    'INV-1,82111-WHM,Washer,360,NOS,Precision,09-Sep-2026,-5',
  ].join('\n'));
  assert.equal(rows.length, 0, 'a bad MOQ must not import silently as no MOQ');
  assert.deepEqual(errors.map((e) => [e.row, e.column]), [[2, 'MOQ'], [3, 'MOQ'], [4, 'MOQ']]);
  assert.match(errors[0].error, /not a number/i);
  assert.match(errors[1].error, /greater than zero/i);
});

test('an MOQ that would print thousands of labels is refused, and says so', async () => {
  // Almost always a 1 typed where 100 was meant.
  const { rows, errors } = await parse([
    HEADER_MOQ,
    'INV-1,76621-MFS,Mount Foot,400000,NOS,DynaFast,09-Sep-2026,1',
  ].join('\n'));
  assert.equal(rows.length, 0);
  assert.equal(errors[0].column, 'MOQ');
  assert.match(errors[0].error, /400000 labels/);
  assert.match(errors[0].error, /limit is 500/);
});

test('the MOQ header is matched by any of its usual spellings', async () => {
  for (const header of ['MOQ', 'moq', 'Min Order Qty', 'Minimum Order Quantity', 'Pack Size']) {
    const { rows, errors } = await parse([
      `${HEADER},${header}`,
      'INV-1,76621-MFS,Mount Foot,350,NOS,DynaFast,09-Sep-2026,300',
    ].join('\n'));
    assert.deepEqual(errors, [], header);
    assert.equal(rows[0].moq, 300, header);
  }
});

test('MOQ is configured as optional, so it cannot become a required column by accident', () => {
  assert.deepEqual(DEFAULTS.grnColsOptional, ['MOQ']);
  assert.ok(!DEFAULTS.grnCols.includes('MOQ'),
    'putting MOQ in grnCols would reject every export produced before the rule');
});

test('an optional column dropped from the configuration is genuinely ignored', () => {
  // NFR-6.1 is the claim that the mapping is configuration rather than code.
  // Reading MOQ merely because FIELD_OF knows the spelling would make the
  // Masters & Config screen offer a setting that does nothing — which is what
  // it did until the audit of this feature went looking for it.
  return (async () => {
    const csv = [
      `${HEADER},MOQ`,
      'INV-1,76621-MFS,Mount Foot,350,NOS,DynaFast,09-Sep-2026,300',
    ].join('\n');

    const configured = await parse(csv);
    assert.equal(configured.rows[0].moq, 300, 'MOQ is configured, so it must be read');

    const dropped = await parse(csv, { optionalCols: [] });
    assert.deepEqual(dropped.errors, [], 'dropping MOQ must not make the file invalid');
    assert.equal(dropped.rows[0].moq, null, 'MOQ is no longer configured, so it must be ignored');
    assert.equal(dropped.rows[0].grn_qty, 350, 'and the rest of the row still imports');
  })();
});

test('a line whose MOQ was ignored prints one label, not a split', async () => {
  const csv = [`${HEADER},MOQ`, 'INV-1,76621-MFS,Mount Foot,350,NOS,DynaFast,09-Sep-2026,300'].join('\n');
  const { rows } = await parse(csv, { optionalCols: [] });
  assert.deepEqual(labelUnits(rows[0]).map((u) => u.label_qty), [350]);
});
