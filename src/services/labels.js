import PDFDocument from 'pdfkit';

/* ============================================================================
   FR-3.1 — the ID label: part number, description, invoice, GRN quantity, GRN
   date, packer, packing date and a scannable code. The PDF is the printable
   artefact (FR-3.2); the frontend draws the same layout on screen for the
   preview, so the two agree.
   ========================================================================== */

/**
 * FR-3.5 — one GRN line becomes one label per MOQ pack, plus a remainder.
 *
 * A line of 350 with an MOQ of 300 is two labels, 300 and 50, because that is
 * how the material physically leaves the table: one full pack and one part
 * pack, each needing its own identification. Without an MOQ — which is every
 * line the system handled before this rule, and every export that does not
 * carry the column — the result is the single whole-quantity label of FR-3.1.
 *
 * Quantities are NUMERIC(14,2), so the arithmetic is done in hundredths. A
 * 0.1-step MOQ divided in floating point drifts, and the drift lands in the
 * remainder label, which is the one a supervisor is least likely to re-check.
 *
 * @returns {object[]} the line, once per label, with `label_qty`, `label_index`
 *   and `label_of`. Never empty.
 */
export function labelUnits(line) {
  const qty = Math.round(Number(line.grn_qty) * 100);
  const moq = line.moq == null || line.moq === '' ? 0 : Math.round(Number(line.moq) * 100);

  if (!Number.isFinite(qty) || qty <= 0) return [{ ...line, label_qty: Number(line.grn_qty), label_index: 1, label_of: 1 }];
  if (!Number.isFinite(moq) || moq <= 0 || moq >= qty) {
    return [{ ...line, label_qty: Number(line.grn_qty), label_index: 1, label_of: 1 }];
  }

  const parts = [];
  for (let left = qty; left > 0; left -= moq) parts.push(Math.min(moq, left));
  return parts.map((p, i) => ({
    ...line,
    label_qty: p / 100,
    label_index: i + 1,
    label_of: parts.length,
  }));
}

/**
 * The one place the label's payload string is defined, so the QR the printer
 * puts on the box and the QR the scanner expects cannot drift apart.
 *
 * A split label carries its *own* quantity, not the line's — a scanner pointed
 * at the 50-unit pouch has to read 50. The index is deliberately not encoded:
 * two labels of the same size carry the same payload, which is right, because
 * the pouches are interchangeable and it is the printed "1 of 2" that tells
 * them apart. That used to be forced by the encoder's 26-byte budget too; the
 * encoder now grows the code to fit, so it is only the scan's meaning talking.
 */
export const labelPayload = (u) => `${u.part_no}|${u.invoice_no}|${u.label_qty ?? u.grn_qty}`;

/* ---- QR encoding ---------------------------------------------------------
   A full QR encoder is a large dependency for one 62pt square. This writes a
   real, scannable QR: byte mode, error-correction level M, in the smallest
   version that holds the payload. */

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

/**
 * The versions this encoder writes, smallest first, all at EC level M.
 *
 * The list stops at 4, and the reason is ink rather than code. Versions 5 and 6
 * need nothing this routine does not already do — the same single alignment
 * pattern at (size-7, size-7), no version-information blocks until 7, and
 * equal-sized RS blocks at level M — but the label draws the code 56pt square
 * whatever version it is, so the module shrinks as the payload grows:
 *
 *     version 4   33×33   1.70pt   0.599mm   4.8 dots on a 203dpi head
 *     version 5   37×37   1.51pt   0.534mm   4.3
 *     version 6   41×41   1.37pt   0.482mm   3.9
 *
 * Below about four dots a module a thermal head starts rounding modules to
 * different widths, and the code stops being reliably scannable. So a payload
 * that would need version 5 is refused rather than printed too dense to read.
 * Adding them back is two rows — but the label would have to draw a bigger
 * square first, and that is a layout decision, not an encoding one.
 *
 * `dataCw` and `ecCw` are the symbol's totals; `blocks` divides both exactly.
 */
const QR_VERSIONS = [
  { version: 2, size: 25, blocks: 1, dataCw: 28, ecCw: 16 },
  { version: 3, size: 29, blocks: 1, dataCw: 44, ecCw: 26 },
  { version: 4, size: 33, blocks: 2, dataCw: 64, ecCw: 36 },
];

/* The header spends 4 bits on the mode and 8 on the byte count — 12 bits, so a
   version carries two bytes fewer than it has data codewords. */
const qrCapacity = (v) => v.dataCw - 2;

/** The smallest version that holds [byteLength] bytes, or undefined if none. */
const qrVersionFor = (byteLength) => QR_VERSIONS.find((v) => byteLength <= qrCapacity(v));

function qrMatrix(text) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const spec = qrVersionFor(bytes.length);
  if (!spec) {
    /* Refusing is the only safe answer left. Truncating produces a code that
       scans perfectly and reports the wrong part number, and nothing between
       here and the shop floor would catch it — the fault surfaces when someone
       picks up a pouch. A failed print is noticed immediately. */
    const largest = QR_VERSIONS[QR_VERSIONS.length - 1];
    throw new Error(
      `Label payload is ${bytes.length} bytes; the largest QR this encoder writes `
      + `(version ${largest.version}-M) holds ${qrCapacity(largest)}: ${text}`,
    );
  }

  // Bit stream: mode 0100 (byte), 8-bit length, data, terminator, padding.
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, spec.dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (cw.length < spec.dataCw) cw.push(padBytes[p++ % 2]);

  /* One Reed-Solomon block per the version's table, then the codewords are
     interleaved: the first of every data block, then the second, and so on,
     with the error-correction blocks interleaved the same way after them. A
     one-block version — 2 and 3 here — falls out of this as plain data-then-EC,
     byte for byte what it was before there was a table. */
  const perBlock = spec.dataCw / spec.blocks;
  const ecPerBlock = spec.ecCw / spec.blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < spec.blocks; b++) {
    const block = cw.slice(b * perBlock, (b + 1) * perBlock);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }
  const all = [];
  for (let i = 0; i < perBlock; i++) for (const b of dataBlocks) all.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of ecBlocks) all.push(b[i]);

  const n = spec.size;
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

  // The one alignment pattern, centred at (n-7, n-7) for every version here.
  const ac = n - 7;
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      m[ac + r][ac + c] = (Math.max(Math.abs(r), Math.abs(c)) !== 1) ? 1 : 0;
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

/**
 * The QR as a matrix of 0/1, for whoever needs to draw it. Square, but not
 * always 25 across — the version grows with the payload — so a caller sizes its
 * cells from the matrix rather than from a constant.
 *
 * @throws {Error} if the payload is longer than the largest version can carry.
 */
export const qrModules = (text) => qrMatrix(text);

/**
 * [text], shortened at the current font until it is no wider than [width],
 * with a trailing ellipsis whenever anything was dropped.
 *
 * PDFKit's `width` is a *wrap* width, not a clip. `lineBreak: false` only
 * stops it defaulting that width to the page — a run too long for the width it
 * was given is still broken onto a second line, which on a label this size
 * drops the overflow onto whatever is printed underneath. A run given no width
 * at all is simply drawn in full, straight across its neighbour. Neither is a
 * thing to print: the label has to be read at a glance and scanned, and the
 * two failures destroy one or the other.
 *
 * `ellipsis: true` is not the answer either — PDFKit only reaches that branch
 * when a `height` is given as well, and what it elides there is the last line
 * of a wrapped block, not an over-long single line. So the fitting is done
 * here, before the string reaches the page, and the run is then drawn with no
 * width at all: one line, already known to fit the space it was measured
 * against.
 */
function fitToWidth(doc, text, width) {
  const s = String(text ?? '');
  if (width <= 0) return '';
  if (doc.widthOfString(s) <= width) return s;

  // Binary search rather than a character-at-a-time walk: the same answer, and
  // a shift's sheet can run to hundreds of labels.
  const ELL = '…';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(s.slice(0, mid) + ELL) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + ELL : '';
}

/**
 * The stocks the label prints on. 100 × 60 mm at 72 dpi is 283.5 × 170.1 pt;
 * 70 × 40 mm is 198.4 × 113.4.
 *
 * The layout is derived, not tabulated: the fields take as many columns as the
 * band beside the code will hold at full width and wrap onto as many rows as
 * that leaves. So the same code sets the five fields — six when the line is
 * split — in three columns over two rows on one stock, and two columns over
 * three rows on the other. The QR is 56pt square on both, because the encoder
 * reaches 33 modules and 56/33 = 1.70pt is already only 4.8 dots on a 203dpi
 * head.
 */
const STOCKS = {
  compact: { size: [198.4, 113.4] },
  standard: { size: [283.5, 170.1] },
};

/**
 * FR-3.2 / FR-3.5 — the printable label sheet: one label per MOQ pack, so a
 * 350 line with an MOQ of 300 produces a 300 label and a 50 label.
 */
export function buildLabelPdf(lines, { template = 'SPD Standard 100×60' } = {}) {
  const stock = template.includes('70×40') ? STOCKS.compact : STOCKS.standard;
  const { size } = stock;
  const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const [W, H] = size;
  const M = 10;

  /* The code is drawn 56pt square at every version, so a module is 56/n pt and
     the quiet zone it needs — four modules of white on every side — is widest
     on the *least* dense code the encoder writes. Everything set against the
     code is held off by that one worst case rather than by the version in
     hand, so the labels of a sheet are laid out identically instead of
     stepping about as the payload crosses a version boundary. */
  const QR_PT = 56;
  const QR_QUIET = 4 * (QR_PT / QR_VERSIONS[0].size);
  const qx = W - M - QR_PT;
  const qy = M;

  /** Nothing printed beside the code may reach past here. */
  const contentRight = qx - QR_QUIET;
  const GAP = 6;

  /* The width a field column has to have, which is the width of the one field
     that must never be abbreviated: an abbreviated date is a wrong date rather
     than a short one, and it is what a storeman reads to decide whether a
     pouch is still within its shelf life. Only the month varies in a
     DD-Mon-YYYY — Helvetica's digits are all one width — so the worst case is
     the widest month name, measured rather than guessed at. */
  doc.font('Helvetica-Bold').fontSize(8.5);
  const FIELD_MIN = Math.max(...MONTHS.map((m) => doc.widthOfString(`00-${m}-0000`)));

  // The wordmark sits on the bottom margin, under the QR's column.
  const WORDMARK_W = 62;
  const wy = H - M - 7.5;

  for (const u of lines.flatMap(labelUnits)) {
    doc.addPage({ size, margin: 0 });

    // The brand ribbon down the left edge, as in the on-screen label.
    const grad = doc.linearGradient(0, 0, 0, H);
    grad.stop(0, '#7A1FB0').stop(0.35, '#E0218A').stop(0.7, '#F06000').stop(1, '#F0C000');
    doc.rect(0, 0, 5, H).fill(grad);

    const x = M + 4;

    /* Both of these are set level with the code, so both stop at its quiet
       zone. The part number used to be bounded by a width PDFKit wraps at
       rather than clips, and the description by a 52-character slice — a proxy
       for a width that a run of capitals overshoots and a run of 'l's never
       reaches. PART_RE in grnImport.js allows 40 characters, and 40 of them
       set 16pt bold is 369pt: three wrapped lines marching down the label over
       the fields. */
    doc.fillColor('#14091F').font('Helvetica-Bold').fontSize(16);
    doc.text(fitToWidth(doc, u.part_no, contentRight - x), x, M, { lineBreak: false });
    doc.fillColor('#444444').font('Helvetica').fontSize(7.5);
    doc.text(fitToWidth(doc, u.part_desc || '', contentRight - x), x, M + 19, { lineBreak: false });

    /* FR-3.1's fields, in the order a storeman reads them: what it is, how
       much of it, and then the three that answer "is this the right pouch, and
       is it current".

       Packer and packing date are what the label can know rather than what it
       would like to. The sheet is printed before the line reaches a table, so
       the packer is whoever staffs the tables it has been allocated to — two
       names if the line is genuinely shared — and the date is the shift's.
       Neither is printed at all until the line is allocated, because a blank
       is honest where a guess is not. */
    const qty = (n) => `${Number(n).toLocaleString('en-IN')} ${u.uom}`;
    const cols = [
      ['INVOICE', u.invoice_no],
      /* FR-3.5 — the label's own quantity, not the line's: this pouch holds 50
         of 350. Which pack it is belongs on this caption rather than anywhere
         else on the label, because this is the number it qualifies. */
      [u.label_of > 1 ? `QTY (${u.label_index} OF ${u.label_of})` : 'QTY', qty(u.label_qty)],
      ['GRN DATE', fmtLabelDate(u.grn_date)],
      ['PACKER', u.packer || '—'],
      ['PACKED ON', u.packed_on ? fmtLabelDate(u.packed_on) : '—'],
    ];

    /* FR-3.1 still wants the GRN quantity, and FR-3.5 has just replaced QTY
       with this pack's share of it — so a split line prints both numbers.

       This used to be a line of its own set under the code, held four modules
       clear of it. That worked while the label carried three fields; with five
       it does not, because the grid then wraps to three rows on the compact
       stock and the two land on each other. Which is the tell that it was
       never a line of its own — a caption and a value is exactly the shape
       everything else in the row already had. As a field it wraps with them,
       and nothing at all is set beneath the code on either stock. */
    if (u.label_of > 1) cols.push(['GRN TOTAL', qty(u.grn_qty)]);
    /* Equal columns across the band left of the code's quiet zone, as many as
       the band will hold at `FIELD_MIN` and the rest wrapping onto a second
       row. The pitch was a flat 78pt on both stocks, which on the standard one
       put the third caption at x=170 and its value through the code's left
       edge on every label the system has printed — and on the compact one put
       it at x=170 on a 198.4pt page, off the sheet entirely.

       The band is 194.5pt on the standard stock, so the fields sit in three
       columns of 60.8pt over two rows. It is 109.4pt on the compact one, which
       takes two columns of 51.7pt over three — still wide enough for the date,
       where a third of that band would not have been. */
    const perRow = Math.max(1, Math.min(cols.length,
      Math.floor((contentRight - x + GAP) / (FIELD_MIN + GAP))));
    const colW = (contentRight - x - GAP * (perRow - 1)) / perRow;
    cols.forEach(([cap, val], i) => {
      const fx = x + (i % perRow) * (colW + GAP);
      const fy = M + 33 + Math.floor(i / perRow) * 18;
      doc.fillColor('#333333').font('Helvetica').fontSize(6.5);
      doc.text(fitToWidth(doc, cap, colW), fx, fy, { lineBreak: false });
      doc.fillColor('#111111').font('Helvetica-Bold').fontSize(8.5);
      doc.text(fitToWidth(doc, val, colW), fx, fy + 8, { lineBreak: false });
    });

    /* QR, top right. A code needs four modules of white on every side — the
       quiet zone is what a scanner locks onto to find the symbol at all — and a
       module here is 56/n pt, where n grows with the payload. So anything set
       against the code measures its clearance in modules rather than points,
       the way the on-screen label's bleed does — `QR_QUIET` above is that
       clearance at the widest module the encoder emits. */
    const mods = qrMatrix(labelPayload(u));
    const cell = QR_PT / mods.length;
    doc.save().fillColor('#111111');
    mods.forEach((row, r) => row.forEach((on, c) => {
      if (on) doc.rect(qx + c * cell, qy + r * cell, cell, cell).fill();
    }));
    doc.restore();

    /* The label carries no barcode and no vendor name: the QR is the one code
       the floor scans, and the vendor is on the GRN paperwork and in the
       system. What is left of the old footer line is the wordmark. */
    doc.fillColor('#555555').font('Helvetica').fontSize(6.5);
    doc.text('SPD PRE-PACK', W - M - WORDMARK_W, wy, { width: WORDMARK_W, align: 'right', lineBreak: false });
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
