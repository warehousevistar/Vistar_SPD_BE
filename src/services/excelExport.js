import ExcelJS from 'exceljs';

/* FR-12.1 — Excel/CSV output for every report. The workbook carries the same
   two-tier header the prototype's export produced: a purple band of column
   groups over the column names, so a supervisor mailing the MIS on can see at a
   glance which columns are the shift, which are the GRN line and which are the
   MIS metrics. */

const BAND = 'FF7A1FB0';
const HEAD = 'FF4A1466';

/**
 * @param {{title, groups?: {t:string,n:number}[], cols: string[], rows: any[][]}} spec
 */
export async function buildWorkbook({ title, groups = [], cols, rows }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vistar SPD — Pre-Packing Automation';
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 30));

  if (groups.length) {
    const band = ws.addRow(groups.flatMap((g) => [g.t, ...Array(g.n - 1).fill('')]));
    let c = 1;
    for (const g of groups) {
      if (g.n > 1) ws.mergeCells(band.number, c, band.number, c + g.n - 1);
      c += g.n;
    }
    band.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  }

  const head = ws.addRow(cols);
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
    cell.alignment = { vertical: 'middle' };
  });

  rows.forEach((r) => ws.addRow(r));

  ws.columns.forEach((col, i) => {
    const widest = Math.max(
      String(cols[i] ?? '').length,
      ...rows.slice(0, 500).map((r) => String(r[i] ?? '').length),
    );
    col.width = Math.min(46, Math.max(11, widest + 3));
  });
  ws.views = [{ state: 'frozen', ySplit: groups.length ? 2 : 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV with a BOM, so Excel opens it in UTF-8 without a prompt. */
export function buildCsv({ cols, rows }) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [cols.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n');
  return Buffer.from('﻿' + body, 'utf8');
}
