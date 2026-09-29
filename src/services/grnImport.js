import ExcelJS from 'exceljs';
import { badRequest } from '../middleware/error.js';

/* ============================================================================
   FR-1.2 / FR-1.3 — structural and row-level validation of the SAP GRN export.

   The SRS is explicit that an invalid file must never fail generically: the
   exact row and column of every problem has to be named (FR-1.3, NFR-4.2). So
   this collects *all* the problems and returns them, rather than throwing on
   the first one — a supervisor who has to re-upload seven times to discover
   seven blanks is back to the manual process.
   ========================================================================== */

/** Canonical field for each configured column header. */
const FIELD_OF = {
  'invoice no.': 'invoice_no',
  'invoice no': 'invoice_no',
  'invoice number': 'invoice_no',
  'part number': 'part_no',
  'part no.': 'part_no',
  'part no': 'part_no',
  'part description': 'part_desc',
  'description': 'part_desc',
  'grn quantity': 'grn_qty',
  'grn qty': 'grn_qty',
  'quantity': 'grn_qty',
  'uom': 'uom',
  'unit': 'uom',
  'vendor': 'vendor',
  'vendor name': 'vendor',
  'vendor code / name': 'vendor',
  'grn date': 'grn_date',
  'date': 'grn_date',
  'moq': 'moq',
  'min order qty': 'moq',
  'minimum order quantity': 'moq',
  'pack size': 'moq',
  'standard pack': 'moq',
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** A part number of letters, digits, dashes and dots — the SAP convention. */
const PART_RE = /^[A-Z0-9][A-Z0-9\-./]{2,39}$/i;

/** FR-3.5 — the most labels one GRN line may split into. Mirrored by the
    grn_lines_moq_label_count constraint, which is the backstop if a row ever
    reaches the table without passing through here. */
const MAX_LABELS_PER_LINE = 500;

function parseCsv(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('That workbook has no sheets — export the GRN report again from SAP (FR-1.3)');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = [];
    // ExcelJS's row.values is 1-based with a leading hole.
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = r.getCell(c);
      let v = cell.value;
      if (v && typeof v === 'object') {
        if (v instanceof Date) v = v;
        else if ('text' in v) v = v.text;
        else if ('result' in v) v = v.result;
        else if ('richText' in v) v = v.richText.map((t) => t.text).join('');
      }
      vals.push(v ?? '');
    }
    if (vals.some((v) => String(v).trim() !== '')) rows.push(vals);
  });
  return rows;
}

/** Excel serial date, ISO text or a real Date — normalised to yyyy-mm-dd. */
function toIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // dd-MMM-yyyy / dd-mm-yyyy / dd/mm/yyyy — the formats the SAP export uses.
  let m = s.match(/^(\d{1,2})[-/](\d{1,2}|[A-Za-z]{3})[-/](\d{2,4})$/);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mm = /^\d+$/.test(m[2]) ? Number(m[2]) : months.indexOf(m[2].toLowerCase()) + 1;
    if (!mm) return null;
    const yyyy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Excel serial (days since 1899-12-30).
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Parses and validates an uploaded GRN export.
 *
 * @returns {{rows: object[], errors: object[], headers: string[]}}
 *   `rows` are the importable lines; `errors` name the row, column, value and
 *   reason for everything rejected. A missing required column is reported with
 *   row `'header'`, exactly as the prototype's error file does.
 */
export async function parseGrnFile({ buffer, filename, requiredCols, optionalCols = [], defaultGrnDate }) {
  const raw = /\.csv$/i.test(filename) ? parseCsv(buffer) : await parseXlsx(buffer);
  if (!raw.length) throw badRequest(`${filename} is empty — nothing to import (FR-1.3)`);

  /* FR-1.2 — locate the header row. SAP exports sometimes carry a title line
     above it, so the first row that maps at least three known headers wins
     rather than assuming row 1. */
  let headerIdx = -1;
  let map = null;
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const candidate = {};
    raw[i].forEach((h, c) => {
      const f = FIELD_OF[norm(h)];
      if (f && candidate[f] === undefined) candidate[f] = c;
    });
    if (Object.keys(candidate).length >= 3) { headerIdx = i; map = candidate; break; }
  }
  if (headerIdx === -1) {
    throw badRequest(
      `No GRN header row found in ${filename}. The file must carry the columns: ${requiredCols.join(', ')} (FR-1.2)`,
      requiredCols.map((c) => ({ row: 'header', column: c, value: '', error: 'Required column missing' })),
    );
  }

  const headers = raw[headerIdx].map((h) => String(h ?? '').trim());
  const errors = [];

  // FR-1.2 — every configured column must be present before a single row is read.
  const missing = requiredCols.filter((c) => map[FIELD_OF[norm(c)]] === undefined);
  for (const c of missing) {
    errors.push({ row: 'header', column: c, value: '', error: 'Required column missing from header row' });
  }
  if (missing.length) {
    throw badRequest(
      `${filename} is missing ${missing.length} required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')} (FR-1.2)`,
      errors,
    );
  }

  const rows = [];
  const seen = new Map(); // invoice|part -> first row number, for in-file duplicates

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    const rowNo = i + 1; // 1-based, as the supervisor sees it in Excel
    const cell = (f) => String(r[map[f]] ?? '').trim();

    const invoice = cell('invoice_no');
    const part = cell('part_no').toUpperCase();
    const desc = cell('part_desc');
    const uom = cell('uom').toUpperCase() || 'NOS';
    const vendor = cell('vendor');
    const qtyRaw = cell('grn_qty');
    const dateRaw = r[map.grn_date];
    const moqRaw = map.moq === undefined ? '' : cell('moq');

    const rowErrors = [];
    if (!invoice) rowErrors.push({ column: 'Invoice No.', value: invoice, error: 'Mandatory value blank' });
    if (!part) rowErrors.push({ column: 'Part Number', value: part, error: 'Mandatory value blank' });
    else if (!PART_RE.test(part)) rowErrors.push({ column: 'Part Number', value: part, error: 'Format not matched' });
    if (!qtyRaw) rowErrors.push({ column: 'GRN Quantity', value: qtyRaw, error: 'Mandatory value blank' });
    else {
      const q = Number(String(qtyRaw).replace(/,/g, ''));
      if (!Number.isFinite(q)) rowErrors.push({ column: 'GRN Quantity', value: qtyRaw, error: 'Not a number' });
      else if (q <= 0) rowErrors.push({ column: 'GRN Quantity', value: qtyRaw, error: 'Must be greater than zero' });
    }
    const iso = toIsoDate(dateRaw) ?? defaultGrnDate;
    if (!iso) rowErrors.push({ column: 'GRN Date', value: String(dateRaw ?? ''), error: 'Date not recognised' });

    /* FR-3.5 — MOQ is optional, so a blank is not an error. A value that is
       present but unusable is, because silently dropping it would print one
       label for the whole quantity and nobody would know the split was lost. */
    let moq = null;
    if (moqRaw) {
      const m = Number(String(moqRaw).replace(/,/g, ''));
      const q = Number(String(qtyRaw).replace(/,/g, ''));
      if (!Number.isFinite(m)) rowErrors.push({ column: 'MOQ', value: moqRaw, error: 'Not a number' });
      else if (m <= 0) rowErrors.push({ column: 'MOQ', value: moqRaw, error: 'Must be greater than zero' });
      else if (Number.isFinite(q) && q / m > MAX_LABELS_PER_LINE) {
        // Almost always an MOQ of 1 where 100 was meant. Saying how many labels
        // it would print is what makes the mistake obvious (NFR-4.2).
        rowErrors.push({
          column: 'MOQ',
          value: moqRaw,
          error: `Would print ${Math.ceil(q / m)} labels for this line; the limit is ${MAX_LABELS_PER_LINE}`,
        });
      } else moq = m;
    }

    const key = `${invoice}|${part}`;
    if (!rowErrors.length && seen.has(key)) {
      rowErrors.push({ column: 'Part Number', value: part, error: `Duplicate of row ${seen.get(key)} in the same file` });
    }

    if (rowErrors.length) {
      rowErrors.forEach((e) => errors.push({ row: rowNo, ...e }));
      continue;
    }

    seen.set(key, rowNo);
    rows.push({
      invoice_no: invoice,
      part_no: part,
      part_desc: desc,
      uom,
      grn_qty: Number(String(qtyRaw).replace(/,/g, '')),
      vendor,
      grn_date: iso,
      moq,
      source_row: rowNo,
    });
  }

  return { rows, errors, headers };
}
