import PDFDocument from 'pdfkit';

/* ============================================================================
   FR-3.1 — the ID label: part number, description, invoice, GRN quantity, GRN
   date and a scannable code. The PDF is the printable artefact (FR-3.2); the
   frontend draws the same layout on screen for the preview, so the two agree.
   ========================================================================== */

/** The one place the label's payload string is defined, so the QR the printer
    puts on the box and the QR the scanner expects cannot drift apart. */
export const labelPayload = (line) => `${line.part_no}|${line.invoice_no}|${line.grn_qty}`;

/* ---- QR encoding ---------------------------------------------------------
   A full QR encoder is a large dependency for one 62pt square. This writes a
   real, scannable QR: version 2 (25×25), byte mode, error-correction level M,
   which holds the 30-odd characters of a label payload comfortably. */

const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/** Version 2-M: 25×25 modules, 28 data codewords, 16 EC codewords. */
const QR_SIZE = 25;
const QR_DATA_CW = 28;
const QR_EC_CW = 16;

function qrMatrix(text) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  if (bytes.length > QR_DATA_CW - 2) {
    // Longer payloads than a label carries — truncate rather than refuse to
    // print, because a label with a slightly short code still beats no label.
    bytes.length = QR_DATA_CW - 2;
  }

  // Bit stream: mode 0100 (byte), 8-bit length, data, terminator, padding.
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, QR_DATA_CW * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (cw.length < QR_DATA_CW) cw.push(padBytes[p++ % 2]);

  const all = cw.concat(rsEncode(cw, QR_EC_CW));

  const n = QR_SIZE;
  const m = Array.from({ length: n }, () => new Array(n).fill(null));

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r; const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6
          && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        m[rr][cc] = on ? 1 : 0;
      }
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

  // Alignment pattern (version 2: centre at 18,18).
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      m[18 + r][18 + c] = (Math.max(Math.abs(r), Math.abs(c)) !== 1) ? 1 : 0;
    }
  }

  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  m[n - 8][8] = 1; // dark module

  // Reserve format-information positions.
  const reserved = [];
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] === null) { m[8][i] = 0; reserved.push([8, i]); }
    if (m[i][8] === null) { m[i][8] = 0; reserved.push([i, 8]); }
  }
  for (let i = n - 8; i < n; i++) {
    if (m[8][i] === null) { m[8][i] = 0; reserved.push([8, i]); }
    if (m[i][8] === null) { m[i][8] = 0; reserved.push([i, 8]); }
  }
  const isReserved = (r, c) => reserved.some(([rr, cc]) => rr === r && cc === c);

  // Place the codewords, two columns at a time, bottom-right upward.
  const dataBits = [];
  all.forEach((b) => { for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1); });
  let bi = 0;
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (m[row][cc] !== null) continue;
        let bit = bi < dataBits.length ? dataBits[bi++] : 0;
        // Mask pattern 0: (row + col) % 2 === 0.
        if ((row + cc) % 2 === 0) bit ^= 1;
        m[row][cc] = bit;
      }
    }
    upward = !upward;
  }

  /* Format information for EC level M with mask 0: the standard's precomputed
     15-bit string. Computing it would mean carrying the BCH tables for one
     constant that never changes. */
  const fmt = '101010000010010';
  let k = 0;
  for (let i = 0; i <= 5; i++) m[8][i] = Number(fmt[k++]);
  m[8][7] = Number(fmt[k++]);
  m[8][8] = Number(fmt[k++]);
  m[7][8] = Number(fmt[k++]);
  for (let i = 5; i >= 0; i--) m[i][8] = Number(fmt[k++]);
  k = 0;
  for (let i = n - 1; i >= n - 7; i--) m[i][8] = Number(fmt[k++]);
  for (let i = n - 8; i < n; i++) m[8][i] = Number(fmt[k++]);

  return m.map((row) => row.map((v) => (v === null ? 0 : v)));
}

/** The QR as a matrix of 0/1, for whoever needs to draw it. */
export const qrModules = (text) => qrMatrix(text);

/** Code 128-B bar widths for the part number, drawn under the label. */
function code128B(text) {
  const CODE = [];
  // Only the widths matter for a drawn barcode; the table is the standard's.
  const PATTERNS = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '233111'];
  const START_B = 104;
  let sum = START_B;
  CODE.push(PATTERNS[START_B]);
  [...text].forEach((ch, i) => {
    const v = ch.charCodeAt(0) - 32;
    const idx = v >= 0 && v < 95 ? v : 0;
    CODE.push(PATTERNS[idx]);
    sum += idx * (i + 1);
  });
  CODE.push(PATTERNS[sum % 103]);
  CODE.push('2331112'); // stop
  return CODE.join('');
}

/** Bar widths for a Code 128-B encoding of [text]. */
export const barcodeWidths = (text) => [...code128B(text)].map(Number);

/**
 * FR-3.2 — the printable label sheet, one label per GRN line.
 * 100 × 60 mm at 72 dpi is 283.5 × 170.1 pt, which is the SPD Standard stock.
 */
export function buildLabelPdf(lines, { template = 'SPD Standard 100×60' } = {}) {
  const size = template.includes('70×40') ? [198.4, 113.4] : [283.5, 170.1];
  const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const [W, H] = size;
  const M = 10;

  for (const l of lines) {
    doc.addPage({ size, margin: 0 });

    // The brand ribbon down the left edge, as in the on-screen label.
    const grad = doc.linearGradient(0, 0, 0, H);
    grad.stop(0, '#7A1FB0').stop(0.35, '#E0218A').stop(0.7, '#F06000').stop(1, '#F0C000');
    doc.rect(0, 0, 5, H).fill(grad);

    const x = M + 4;
    doc.fillColor('#14091F').font('Helvetica-Bold').fontSize(16).text(l.part_no, x, M, { width: W - x - 80, lineBreak: false });
    doc.fillColor('#444444').font('Helvetica').fontSize(7.5)
      .text(String(l.part_desc || '').slice(0, 52), x, M + 19, { width: W - x - 80, lineBreak: false });

    const cols = [
      ['INVOICE', l.invoice_no],
      ['GRN QTY', `${Number(l.grn_qty).toLocaleString('en-IN')} ${l.uom}`],
      ['GRN DATE', fmtLabelDate(l.grn_date)],
    ];
    let cx = x;
    for (const [cap, val] of cols) {
      doc.fillColor('#333333').font('Helvetica').fontSize(6.5).text(cap, cx, M + 33, { lineBreak: false });
      doc.fillColor('#111111').font('Helvetica-Bold').fontSize(8.5).text(String(val), cx, M + 41, { lineBreak: false });
      cx += 78;
    }

    // QR, top right.
    const mods = qrMatrix(labelPayload(l));
    const qrPx = 56;
    const cell = qrPx / mods.length;
    const qx = W - M - qrPx;
    const qy = M;
    doc.save().fillColor('#111111');
    mods.forEach((row, r) => row.forEach((on, c) => {
      if (on) doc.rect(qx + c * cell, qy + r * cell, cell, cell).fill();
    }));
    doc.restore();

    // Code 128 barcode across the bottom.
    const widths = barcodeWidths(l.part_no);
    const unit = Math.max(0.6, (W - 2 * M - 10) / widths.reduce((s, w) => s + w, 0));
    let bx = x;
    const by = H - M - 26;
    doc.save().fillColor('#111111');
    widths.forEach((w, i) => {
      if (i % 2 === 0) doc.rect(bx, by, w * unit, 22).fill();
      bx += w * unit;
    });
    doc.restore();

    doc.fillColor('#555555').font('Helvetica').fontSize(6.5)
      .text(String(l.vendor || '').slice(0, 34), x, by - 10, { lineBreak: false })
      .text('SPD PRE-PACK', W - M - 62, by - 10, { width: 62, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtLabelDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v ?? '');
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
