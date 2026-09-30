import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import PDFDocument from 'pdfkit';

import { qrModules, labelPayload, labelUnits, buildLabelPdf } from '../src/services/labels.js';

/* ============================================================================
   The QR encoder in services/labels.js is written by hand — bit stream,
   Reed-Solomon, block interleaving, module placement and masking. Nothing
   downstream would notice if it were subtly wrong: the label prints, it looks
   like a QR code, and the fault only surfaces when someone on the floor points
   a scanner at it and nothing happens — or, worse, it scans and reads back a
   part number that was never on the pouch.

   So this decodes it. The decoder below is written from the specification's
   reading order rather than from the encoder, and it is first proved against
   matrices produced by an independent implementation (the Dart `qr` package,
   captured by frontend/tool/qr_reference.dart) — one for every version the
   encoder can emit. A decoder that reads known-good codes, and then reads ours
   back to the same payload, is real evidence the labels scan.
   ========================================================================== */

/**
 * A known-good matrix for every version the encoder can reach, from the `qr`
 * Dart package — regenerate with `dart run tool/qr_reference.dart` in frontend/.
 *
 * The payloads are the label's own shape, sized to force each version in turn:
 * an ordinary part number, a longer one, and the 40-character maximum PART_RE
 * in grnImport.js allows. The package picks its own mask, so these are not
 * expected to match ours module for module; what must match is the codewords
 * underneath, and that is asserted below.
 */
const REFERENCES = [
  {
    version: 2,
    payload: '90210-ABX|INV-77001|270',
    rows: [
      '1111111011010100101111111', '1000001001001000001000001', '1011101011100111101011101',
      '1011101000100100101011101', '1011101000101100101011101', '1000001010110000101000001',
      '1111111010101010101111111', '0000000000000011100000000', '1010001101001001000100101',
      '1100100101100111011100011', '0010001100101101000111011', '1101010000111001100010000',
      '0100011111001011001010011', '0100000000101011000100011', '1100011110001011010100111',
      '0011000101011000110000010', '1101111010000010111110010', '0000000010000010100010011',
      '1111111010110000101011111', '1000001000100010100010011', '1011101001111011111111001',
      '1011101001101010110001110', '1011101011001110111010111', '1000001001011001011101000',
      '1111111011001110110111101',
    ],
  },
  {
    version: 3,
    payload: '90210-ABX-BRACKET-FRONT-LH|INV-77001|270',
    rows: [
      '11111110001110000101001111111', '10000010101010101000001000001', '10111010111110010011101011101',
      '10111010111011100111101011101', '10111010010000100110101011101', '10000010011101000000101000001',
      '11111110101010101010101111111', '00000000100110000001100000000', '10000010101011011001011001110',
      '01101101010110011110001110110', '11000110110011110000010001010', '10101101010100100011010010001',
      '11101111100100110101001010011', '00011100010110110110100110011', '00100111001110011010010000010',
      '11001000101110110011010010101', '10110111100010011100000010110', '10001100011001010100100111111',
      '11010111000110010101010010111', '10110000111001011010111101010', '10001011011000111001111110011',
      '00000000101000111110100010110', '11111110001100011011101011010', '10000010000100101000100011000',
      '10111010001111101101111111110', '10111010011111110110010000001', '10111010010011010101010010110',
      '10000010011111010011111011101', '11111110100110011001000001000',
    ],
  },
  {
    version: 4,
    payload: '90210-ABX-BRACKET-FRONT-LH-REV12-A/B.012|INV-77001|270',
    rows: [
      '111111101011000010110100001111111', '100000100111100011010010001000001', '101110100111010101111101001011101',
      '101110101111001100011011001011101', '101110101011011001001011101011101', '100000101100100011011100101000001',
      '111111101010101010101010101111111', '000000001011100111010100100000000', '100010111010001000011010111111001',
      '010001011110010010010000011100111', '101010110000000111000001000011010', '100000000101001011010100010111010',
      '100100100010111000110100011111000', '100101001110100010101110000000100', '100100111101111011100011000110000',
      '000010011011100001001100101111010', '001100110001100111100011001000010', '011010010100100011110000001100110',
      '000001111100001100100001000011100', '010101000110010100011100001001001', '001101101010100110010100101111011',
      '100111010111100001100010000001000', '000110101011010101101101101100100', '001011010000100111100101000000001',
      '111110110100100000011011111110101', '000000001001011100110010100010100', '111111101011101111001111101010000',
      '100000100100000111101110100011010', '101110101011101100100100111111011', '101110100010100011001011111010100',
      '101110100000000011100100101111100', '100000100001101001000111011111000', '111111101011010100011101111000001',
    ],
  },
].map((r) => ({ ...r, modules: r.rows.map((row) => [...row].map((ch) => ch === '1')) }));

/** Version 2 carrying the seeded demo payload — the shape a label has today. */
const REFERENCE = REFERENCES[0].modules;
const REFERENCE_PAYLOAD = REFERENCES[0].payload;

/* ---- an independent decoder, written from the spec ------------------- */

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => ((((i * j) % 2) + ((i * j) % 3)) % 2) === 0,
  (i, j) => ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0,
];

/**
 * The Reed-Solomon block layout at EC level M, from the standard's table.
 *
 * Written out here rather than imported from the encoder: a decoder that took
 * the encoder's own table would agree with it however wrong it was. What proves
 * these numbers is that they read the reference matrices above, which nothing
 * in this repository produced.
 */
const BLOCKS_M = {
  2: { blocks: 1, dataCw: 28 },
  3: { blocks: 1, dataCw: 44 },
  4: { blocks: 2, dataCw: 64 },
};

/** A version-v symbol is 4v+17 modules square. */
const versionOf = (n) => (n - 17) / 4;

/** Versions 2 to 6 carry one alignment pattern, centred at (n-7, n-7). */
function isFunctionModule(n, r, c) {
  if (r <= 8 && c <= 8) return true;                       // top-left finder + format
  if (r <= 8 && c >= n - 8) return true;                   // top-right finder + format
  if (r >= n - 8 && c <= 8) return true;                   // bottom-left finder + format
  if (r === 6 || c === 6) return true;                     // timing
  const a = n - 7;
  if (r >= a - 2 && r <= a + 2 && c >= a - 2 && c <= a + 2) return true; // alignment
  return false;
}

/** The 15 format bits, read from the copy around the top-left finder. */
function readFormat(m) {
  const bits = [];
  for (let i = 0; i <= 5; i++) bits.push(m[8][i] ? 1 : 0);
  bits.push(m[8][7] ? 1 : 0);
  bits.push(m[8][8] ? 1 : 0);
  bits.push(m[7][8] ? 1 : 0);
  for (let i = 5; i >= 0; i--) bits.push(m[i][8] ? 1 : 0);
  const raw = parseInt(bits.join(''), 2) ^ 0b101010000010010;
  return { ec: (raw >> 13) & 0b11, mask: (raw >> 10) & 0b111 };
}

/**
 * The codeword stream in placement order — interleaved data, then interleaved
 * error correction. Two matrices holding the same payload at the same version
 * must produce the same stream, whatever masks they chose.
 */
function readCodewords(m) {
  const n = m.length;
  const isMasked = MASKS[readFormat(m).mask];

  const bits = [];
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;                                  // skip the timing column
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const cc = col - k;
        if (isFunctionModule(n, row, cc)) continue;
        let bit = m[row][cc] ? 1 : 0;
        if (isMasked(row, cc)) bit ^= 1;
        bits.push(bit);
      }
    }
    upward = !upward;
  }

  // Versions 2 to 6 end in 7 remainder bits, which are not part of a codeword.
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return cw;
}

/* GF(256) under the QR primitive polynomial, so the error-correction codewords
   can be checked the way a scanner checks them. */
const EXP = new Array(512);
const LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Undoes the interleave: the stream back into its RS blocks, data and EC. */
function deinterleave(cw, version) {
  const { blocks, dataCw } = BLOCKS_M[version];
  const dataLen = dataCw / blocks;
  const ecLen = (cw.length - dataCw) / blocks;
  const out = [];
  for (let b = 0; b < blocks; b++) {
    const data = [];
    const ec = [];
    for (let i = 0; i < dataLen; i++) data.push(cw[i * blocks + b]);
    for (let i = 0; i < ecLen; i++) ec.push(cw[dataCw + i * blocks + b]);
    out.push({ data, ec });
  }
  return out;
}

/**
 * The syndromes of one block. All zero means the block satisfies its own error
 * correction, which is what decides whether a scanner reads a code at all — a
 * round trip through our own reader would succeed even if every EC codeword
 * were wrong, and a code like that fails on the first smudge.
 */
function syndromes({ data, ec }) {
  const poly = [...data, ...ec];
  return Array.from({ length: ec.length }, (_, i) => {
    let s = 0;
    for (const c of poly) s = gmul(s, EXP[i]) ^ c;
    return s;
  });
}

function decode(m) {
  const version = versionOf(m.length);
  assert.ok(BLOCKS_M[version],
    `matrix is ${m.length} modules square — not a version this decoder knows`);
  const blocks = deinterleave(readCodewords(m), version);

  blocks.forEach((b, i) => {
    assert.deepEqual(syndromes(b), new Array(b.ec.length).fill(0),
      `version ${version}: block ${i} does not satisfy its error-correction codewords`);
  });

  const bits = [];
  for (const b of blocks) for (const c of b.data) for (let i = 7; i >= 0; i--) bits.push((c >> i) & 1);

  const mode = parseInt(bits.slice(0, 4).join(''), 2);
  assert.equal(mode, 0b0100, 'expected byte mode');
  const len = parseInt(bits.slice(4, 12).join(''), 2);
  const bytes = [];
  for (let i = 0; i < len; i++) {
    bytes.push(parseInt(bits.slice(12 + i * 8, 20 + i * 8).join(''), 2));
  }
  return Buffer.from(bytes).toString('utf8');
}

/* ---- the decoder is only worth trusting once it reads known-good codes ---- */

test('the decoder reads QR codes produced by an independent implementation', () => {
  for (const r of REFERENCES) {
    assert.equal(r.modules.length, 4 * r.version + 17, `version ${r.version} is the wrong size`);
    assert.equal(decode(r.modules), r.payload, `version ${r.version} reference did not decode`);
  }
});

test('our encoder lays down the same codewords as that implementation', () => {
  /* Decoding our own code back to its payload proves the data codewords and
     nothing else: our reader would return the payload even if every error
     correction codeword were wrong. Underneath the mask, though, the codewords
     are a function of the payload and the version alone — so ours must equal
     the Dart package's exactly, error correction and block interleaving
     included, even though the two matrices differ because it chose its own
     mask. This is what proves the version 4 interleave. */
  for (const r of REFERENCES) {
    const ours = qrModules(r.payload).map((row) => row.map((v) => v === 1));
    assert.equal(ours.length, r.modules.length,
      `${r.payload.length} bytes should have chosen version ${r.version}`);
    assert.deepEqual(readCodewords(ours), readCodewords(r.modules),
      `version ${r.version}: our codewords differ from the reference's`);
  }
});

test('our encoder produces a code that decodes back to its payload', () => {
  for (const payload of [
    REFERENCE_PAYLOAD,
    '90211-ABX|INV-77001|340',
    'EV301-BMS|INV-77004|100',
    'A|B|1',
    ...REFERENCES.map((r) => r.payload),
    // every capacity boundary, and the byte either side of it
    ...[25, 26, 27, 41, 42, 43, 61, 62].map((n) => 'X'.repeat(n)),
  ]) {
    const m = qrModules(payload).map((row) => row.map((v) => v === 1));
    assert.equal(decode(m), payload, `round trip failed for ${payload}`);
  }
});

/* ---- choosing a version ------------------------------------------------- */

test('the encoder picks the smallest version the payload fits in', () => {
  // 26, 42 and 62 bytes are the standard's byte-mode capacities at level M for
  // versions 2, 3 and 4: a 12-bit header, and then whole bytes.
  const cases = [
    [1, 25], [25, 25], [26, 25],
    [27, 29], [41, 29], [42, 29],
    [43, 33], [61, 33], [62, 33],
  ];
  for (const [bytes, size] of cases) {
    assert.equal(qrModules('X'.repeat(bytes)).length, size,
      `${bytes} bytes belongs in a ${size}×${size} code`);
  }
});

test('a payload that used to be truncated now round-trips intact', () => {
  /* 40 characters is exactly what PART_RE in grnImport.js permits, so this is
     an ordinary import rather than a pathological one. The old encoder cut it
     to 26 bytes and printed a perfectly scannable code reading
     '90210-ABX-BRACKET-FRONT-LH' — no invoice, no quantity, and no complaint
     from anything between here and the pouch. */
  const payload = '90210-ABX-BRACKET-FRONT-LH-REV12-A/B.012|INV-77001|270';
  assert.equal(Buffer.byteLength(payload), 54);

  const m = qrModules(payload);
  assert.equal(m.length, 33, 'version 4 is the smallest that holds 54 bytes');
  assert.equal(decode(m.map((row) => row.map((v) => v === 1))), payload);
});

test('a payload too long for any supported version is refused, not truncated', () => {
  /* Refusing is the safe failure. A truncated code scans cleanly and reports a
     part number that does not exist, and the first thing to notice is a scanner
     on the floor; a print that fails is noticed at the printer. */
  assert.throws(() => qrModules('X'.repeat(63)), /63 bytes[\s\S]*version 4-M[\s\S]*holds 62/);
  assert.doesNotThrow(() => qrModules('X'.repeat(62)));

  /* Where the limit actually falls, because at version 4 it is reachable.
     PART_RE caps a part number at 40 characters; against a three-digit quantity
     that leaves 17 for the invoice number, which has no length rule of its own.
     An ordinary part number leaves far more room — 47 characters at a length of
     ten — so this bites only where a maximum-length part meets a long invoice.
     It is still the right failure: the alternative was a code that scanned
     cleanly and named a part that was never on the pouch. */
  const widest = (part, invoice) => `${'P'.repeat(part)}|${'I'.repeat(invoice)}|270`;
  assert.equal(Buffer.byteLength(widest(40, 17)), 62);
  assert.doesNotThrow(() => qrModules(widest(40, 17)));
  assert.throws(() => qrModules(widest(40, 18)), /63 bytes/);
  assert.doesNotThrow(() => qrModules(widest(10, 47)));
});

/**
 * Version-2 matrices exactly as the encoder drew them before it knew about any
 * other version, captured from the previous implementation.
 *
 * A label is printed once and scanned for as long as the stock lasts, so every
 * payload that fitted version 2 has to keep producing the same 25×25 code. This
 * is the assertion that the change is invisible to labels already on pouches.
 */
const UNCHANGED = {
  '90210-ABX|INV-77001|270': [
    '1111111000000001101111111', '1000001010011101001000001', '1011101000110010101011101',
    '1011101001110001101011101', '1011101011111001101011101', '1000001001100101101000001',
    '1111111010101010101111111', '0000000001010110100000000', '1010101000011100000010010',
    '1001110000110010001001001', '0111011001111000010010001', '1000000101101100110111010',
    '0001001010011110011111001', '0001010101111110010001001', '1001001011011110000001101',
    '0110010000001101100101000', '1000101111010111111111000', '0000000011010111100011001',
    '1111111001100101101010101', '1000001001110111100011001', '1011101010101110111110011',
    '1011101000111111100100100', '1011101010011011101111101', '1000001000001100001000010',
    '1111111010011011100010111',
  ],
  'A|B|1': [
    '1111111000011100101111111', '1000001011010011101000001', '1011101001110110101011101',
    '1011101001000111001011101', '1011101011110010001011101', '1000001001111100001000001',
    '1111111010101010101111111', '0000000001011110100000000', '1010101001010011000010010',
    '1101010000000011000101010', '1010001010001100010110011', '1011010010001001011100010',
    '0111011100101000110011010', '0011110111111101110010101', '1000111000011011101000111',
    '0110000011101110100011000', '1011001011110011111111001', '0000000011110010100011010',
    '1111111001100100101011111', '1000001000110001100011000', '1011101011101000111110111',
    '1011101001111100010000110', '1011101010011010111010001', '1000001001101111001000110',
    '1111111010110011000010111',
  ],
  '90210-ABXYZ|INV-77001|2700': [
    '1111111001100001101111111', '1000001010001011101000001', '1011101001101001001011101',
    '1011101001011001101011101', '1011101011110001101011101', '1000001001011101101000001',
    '1111111010101010101111111', '0000000000010101100000000', '1010101001011111100010010',
    '1010110001000110000001001', '1111111110010010100010001', '1001100010010100100111010',
    '1100111000101110011111001', '0110110000110111100001001', '1010011011101010100001101',
    '0110010001010110111101000', '1011111111000101111111000', '0000000011100011100011001',
    '1111111000101000101010101', '1000001000110100100011011', '1011101011100110111110000',
    '1011101001100110000100100', '1011101010100110010111101', '1000001000001101001000010',
    '1111111011000111101010111',
  ],
};

test('short payloads still produce byte-identical version-2 matrices', () => {
  for (const [payload, rows] of Object.entries(UNCHANGED)) {
    assert.deepEqual(qrModules(payload).map((row) => row.join('')), rows,
      `${payload} (${Buffer.byteLength(payload)} bytes) no longer draws the code it used to`);
  }
});

test('every version carries the structure a scanner locks onto', () => {
  for (const { payload, version } of REFERENCES) {
    const m = qrModules(payload);
    const n = 4 * version + 17;
    assert.equal(m.length, n, `version ${version} is ${n} modules square`);
    assert.ok(m.every((r) => r.length === n));

    // three finder patterns: a 7×7 ring with a 3×3 core
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const onRing = r === 0 || r === 6 || c === 0 || c === 6;
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          assert.equal(m[r0 + r][c0 + c], onRing || inCore ? 1 : 0,
            `v${version} finder at ${r0},${c0} wrong at ${r},${c}`);
        }
      }
    }

    // the one alignment pattern: a 5×5 ring around a single dark centre
    const a = n - 7;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        assert.equal(m[a + r][a + c], Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0,
          `v${version} alignment pattern wrong at ${r},${c}`);
      }
    }

    // timing patterns alternate all the way between the finders
    for (let i = 8; i < n - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `v${version} horizontal timing at ${i}`);
      assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `v${version} vertical timing at ${i}`);
    }

    // the dark module is always set
    assert.equal(m[n - 8][8], 1, `v${version} dark module`);

    // format info declares error-correction level M with mask 0
    const fmt = readFormat(m.map((r) => r.map((v) => v === 1)));
    assert.equal(fmt.ec, 0b00, `v${version} EC level M`);
    assert.equal(fmt.mask, 0, `v${version} mask 0`);
  }
});

/* ---- payload + PDF ----------------------------------------------------- */

test('the label payload is the one string both the printer and the scanner use', () => {
  assert.equal(
    labelPayload({ part_no: '90210-ABX', invoice_no: 'INV-77001', grn_qty: 270 }),
    '90210-ABX|INV-77001|270',
  );
});

test('the label sheet is a PDF with one page per label', async () => {
  const lines = [1, 2, 3].map((i) => ({
    part_no: `PART-${i}`, part_desc: 'Description', invoice_no: `INV-${i}`,
    grn_qty: 100 * i, uom: 'NOS', vendor: 'Vendor', grn_date: '2026-09-09',
  }));
  const pdf = await buildLabelPdf(lines);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.equal(countPages(pdf), 3, 'one page per label');
});

/* ---- FR-3.5: what actually reaches the paper ---------------------------- */

const countPages = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;

/**
 * A drawn run's characters, out of the hex string PDFKit writes for it.
 *
 * The label's fonts are WinAnsi-encoded, which is Latin-1 everywhere except a
 * handful of bytes in 0x80–0x9F. Two of those reach the label: the ellipsis it
 * cuts over-long values with, and the em dash it prints where a field is not
 * known yet. Decoding either as Latin-1 turns the evidence into an invisible
 * control character — an assertion then reads `"" is in the quiet zone`, which
 * says nothing about which field is at fault.
 */
const WIN_ANSI = { 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };
const runText = (arr) => [...arr.matchAll(/<([0-9A-Fa-f]+)>/g)]
  .map(([, hex]) => [...Buffer.from(hex, 'hex')]
    .map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join(''))
  .join('');

/**
 * The text drawn on each page, by inflating the content streams.
 *
 * Counting pages proves the sheet has the right *number* of labels and nothing
 * about what is on them — a split that produced two pages both reading 350
 * would pass a page count and send someone to pack the wrong pouch. PDFKit
 * Flate-compresses each page's content stream, so the only way to read the
 * printed quantity back is to inflate it.
 */
function pageTexts(pdf) {
  const pages = [];
  let i = 0;
  while ((i = pdf.indexOf('stream', i)) >= 0) {
    // 'endstream' also contains 'stream'; those hits are not stream starts.
    if (i >= 3 && pdf.subarray(i - 3, i).toString('latin1') === 'end') { i += 6; continue; }
    let s = i + 'stream'.length;
    if (pdf[s] === 0x0d) s++;
    if (pdf[s] === 0x0a) s++;
    const e = pdf.indexOf('endstream', s);
    if (e < 0) break;
    let txt = null;
    try { txt = zlib.inflateSync(pdf.subarray(s, e)).toString('latin1'); } catch { /* not flate */ }
    if (txt && /\bTJ\b/.test(txt)) {
      // PDFKit writes glyphs as hex strings inside a TJ array, not as (…) Tj.
      const words = [...txt.matchAll(/\[([^\]]*)\]\s*TJ/g)].map(([, arr]) => runText(arr));
      pages.push(words.join(' | '));
    }
    i = e + 'endstream'.length;
  }
  return pages;
}

/**
 * The line every geometry test below is drawn from.
 *
 * `packer` carries two names on purpose. A line can be allocated to several
 * tables now, so the field holds whoever staffs them, and the geometry has to
 * survive the widest thing that can honestly appear there rather than the
 * em dash an unallocated line prints. A fixture that left it unset would have
 * every field fit trivially and prove nothing.
 */
const split = {
  part_no: '76621-MFS', part_desc: 'Mudflap Set', invoice_no: 'INV-77003',
  grn_qty: 350, moq: 300, uom: 'SET', vendor: 'BlueVolt', grn_date: '2026-09-09',
  packer: 'Rajesh Menon, Anita Deshpande', packed_on: '2026-09-09',
};

test('a line with an MOQ prints one page per pack', async () => {
  assert.equal(countPages(await buildLabelPdf([split])), 2);
  assert.equal(countPages(await buildLabelPdf([{ ...split, grn_qty: 360, moq: 100 }])), 4);
  assert.equal(countPages(await buildLabelPdf([{ ...split, grn_qty: 300, moq: 300 }])), 1);
  assert.equal(countPages(await buildLabelPdf([{ ...split, grn_qty: 140, moq: 200 }])), 1);
  assert.equal(countPages(await buildLabelPdf([{ ...split, moq: null }])), 1);
});

test('each printed page carries its own pack quantity, not the line total', async () => {
  const pages = pageTexts(await buildLabelPdf([split]));
  assert.equal(pages.length, 2, `expected two pages, got: ${pages.join(' /// ')}`);

  assert.match(pages[0], /\b300 SET\b/, 'the first label should hold the full pack');
  assert.match(pages[1], /\b50 SET\b/, 'the second label should hold the remainder');
  /* The line total appears once, as the GRN TOTAL field, and the pack's own
     share is what QTY carries. Stripping the one place 350 is allowed to
     appear is what makes this an assertion about the *quantity* field rather
     than about the string being absent from the page altogether. */
  assert.ok(!/\b350 SET\b/.test(pages[1].replace(/GRN TOTAL \| 350 SET/g, '')),
    'the remainder label must not present the line total as its quantity');

  // FR-3.1 — the GRN quantity is still on both labels, beside the pack's share.
  for (const [n, page] of pages.entries()) {
    assert.match(page, /GRN TOTAL \| 350 SET/, `page ${n + 1} dropped the GRN quantity`);
    assert.match(page, new RegExp(`QTY \\(${n + 1} OF 2\\)`), `page ${n + 1} is not numbered`);
    assert.match(page, /76621-MFS/);
    assert.match(page, /INV-77003/);
  }
});

test('an unsplit label carries no split marker', async () => {
  const [page] = pageTexts(await buildLabelPdf([{ ...split, moq: null }]));
  assert.match(page, /\b350 SET\b/);
  assert.ok(!/ OF /.test(page), 'a line that was never split must not be numbered');
  assert.ok(!/GRN TOTAL/.test(page),
    'and must not print the quantity twice — it looked exactly like this before MOQ existed');
});

test('the whole-shift sheet adds up to the sum of the lines’ label counts', async () => {
  // This is the invariant behind the "Print sheet · N" button: the number the
  // console shows a Supervisor is the number of pages that reach the printer.
  const lines = [
    { ...split, grn_qty: 350, moq: 300 },   // 2
    { ...split, grn_qty: 360, moq: 100 },   // 4
    { ...split, grn_qty: 270, moq: null },  // 1
    { ...split, grn_qty: 300, moq: 300 },   // 1
  ];
  const expected = lines.reduce((n, l) => n + labelUnits(l).length, 0);
  assert.equal(expected, 8);
  assert.equal(countPages(await buildLabelPdf(lines)), expected);
});

/* ---- the QR's quiet zone on paper --------------------------------------- */

/**
 * Every page's drawn ink, positioned: the filled rectangles and the text runs.
 *
 * `pageTexts` above reads *what* is printed; a label can carry every right
 * character and still not scan, because a scanner finds a QR by the band of
 * white around it — four modules on every side — and the only thing the sheet
 * puts anywhere near the code is the split marker, directly underneath.
 *
 * PDFKit flips the page (`1 0 0 -1 0 H cm`) so its own drawing calls are
 * top-down, then flips back around each text run so the glyphs are not
 * mirrored. So a rectangle's operands are already in label coordinates, and a
 * text matrix's y has to be taken off the page height to join them.
 */
function pageDraws(pdf, H = 170.1) {
  const pages = [];
  let i = 0;
  while ((i = pdf.indexOf('stream', i)) >= 0) {
    if (i >= 3 && pdf.subarray(i - 3, i).toString('latin1') === 'end') { i += 6; continue; }
    let s = i + 'stream'.length;
    if (pdf[s] === 0x0d) s++;
    if (pdf[s] === 0x0a) s++;
    const e = pdf.indexOf('endstream', s);
    if (e < 0) break;
    let txt = null;
    try { txt = zlib.inflateSync(pdf.subarray(s, e)).toString('latin1'); } catch { /* not flate */ }
    if (txt && /\bTJ\b/.test(txt)) {
      const rects = [...txt.matchAll(/(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+) re/g)]
        .map(([, x, y, w, h]) => ({ x: +x, y: +y, w: +w, h: +h }));
      const texts = [...txt.matchAll(
        /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*\/(\w+) ([\d.]+) Tf\s*\[([^\]]*)\]\s*TJ/g,
      )].map(([, x, y, font, size, arr]) => ({
        x: +x,
        // Helvetica's ascender and cap height are both 718/1000 em, and PDFKit
        // sets the baseline an ascender below the y it is given — so for a run
        // of capitals and digits that y is the top of the ink, exactly.
        top: H - +y - 0.718 * +size,
        baseline: H - +y,
        // Helvetica's descender is 207/1000 em below the baseline.
        foot: H - +y + 0.207 * +size,
        size: +size,
        font,
        text: runText(arr),
      }));
      pages.push({ rects, texts });
    }
    i = e + 'endstream'.length;
  }
  return pages;
}

/**
 * The `/F1` → `Helvetica-Bold` mapping the pages are drawn against.
 *
 * A run's width — and so where on the label its ink ends — is only meaningful
 * in the face it was set in, and the content stream names a page resource
 * rather than a font. PDFKit numbers those resources in order of first use, so
 * hard-coding them would be a promise about the order the label happens to
 * draw in today. The font dictionaries are not compressed, so read them.
 */
function pageFonts(pdf) {
  const s = pdf.toString('latin1');
  const base = new Map();
  for (const [, num, dict] of s.matchAll(/(\d+) 0 obj\s*(<<[^>]*\/BaseFont[^>]*>>)/g)) {
    base.set(num, /\/BaseFont \/(\S+)/.exec(dict)[1]);
  }
  const fonts = {};
  for (const [, res] of s.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
    for (const [, name, num] of res.matchAll(/\/(\w+) (\d+) 0 R/g)) fonts[name] = base.get(num);
  }
  assert.ok(Object.keys(fonts).length, 'no font resources found in the PDF');
  return fonts;
}

/**
 * Where a run's ink ends, measured in the face and size it was drawn at.
 *
 * PDFKit lays a run down at exactly the advance widths it reports, so asking
 * it is asking the thing that did the drawing — and it is the only way to get
 * from "this string starts at x" to "this string reaches x", which is the
 * whole question a quiet zone asks.
 */
function inkRight(ruler, fonts, t) {
  assert.ok(fonts[t.font], `the run ${JSON.stringify(t.text)} names an unknown font /${t.font}`);
  ruler.font(fonts[t.font]).fontSize(t.size);
  return t.x + ruler.widthOfString(t.text);
}

/** A throwaway document, used only for its font metrics. */
const ruler = () => new PDFDocument({ size: [283.5, 170.1], margin: 0 });

/** The QR's drawn extent: its modules are the only small squares on the page. */
function drawnQr(page) {
  const mods = page.rects.filter((r) => r.w === r.h && r.w < 3);
  assert.ok(mods.length > 0, 'no QR modules on the page');
  return {
    cell: mods[0].w,
    left: Math.min(...mods.map((m) => m.x)),
    right: Math.max(...mods.map((m) => m.x + m.w)),
    top: Math.min(...mods.map((m) => m.y)),
    bottom: Math.max(...mods.map((m) => m.y + m.h)),
  };
}

/**
 * The same two-page split sheet, drawn once at every version the encoder emits.
 *
 * The code is 56pt square whatever version it is, so the module shrinks as the
 * payload grows — 2.24pt at 25 modules down to 1.70pt at 33 — and a clearance
 * fixed in points is a different number of modules on each of these. The
 * invoice number is what is stretched to reach them: PART_RE caps a part number
 * at 40 characters, invoice_no has no limit of its own, and both pages of a
 * split have to land in the same version for the count below to hold.
 */
const QUIET_CASES = [
  { modules: 25, invoice: 'INV-77003' },
  { modules: 29, invoice: 'INV-77003/2026-27/04' },
  { modules: 33, invoice: 'INV-77003/2026-27/04-BLUEVOLT-MUMBAI-1' },
];

test('a split line prints its pack index and line total as fields', async () => {
  /* It used to be set on its own under the QR, held four modules clear of the
     bottom edge. That was the right answer while the label carried three
     fields; with five it is not, because the grid then wraps to three rows on
     the compact stock and the two land on each other — the collision this
     replaced, which read:

       "Rajesh Me…" at x 71.7..122.3 y 69.0..76.9 lands on
       "1 OF 2  ·  GRN 350 SET" at x 107.1..188.4 y 75.0..81.9

     So it is a field now: "1 OF 2" is a caption and "GRN 350 SET" a value, the
     shape everything else in that row already had. It wraps with them, and
     nothing at all is set beneath the code. */
  for (const { modules, invoice } of QUIET_CASES) {
    const pages = pageDraws(await buildLabelPdf([{ ...split, invoice_no: invoice }]));
    assert.equal(pages.length, 2, `${modules} modules: expected a split into two pages`);

    for (const [n, page] of pages.entries()) {
      const qr = drawnQr(page);
      assert.equal(Math.round(56 / qr.cell), modules,
        `page ${n + 1}: a ${invoice.length}-character invoice should draw a ${modules}-module code`);

      const caption = page.texts.find((t) => t.text === 'GRN TOTAL');
      const value = page.texts.find((t) => t.text === '350 SET');
      assert.ok(caption && value, `page ${n + 1}: no GRN TOTAL field`);
      assert.ok(page.texts.some((t) => t.text === `QTY (${n + 1} OF 2)`),
        `page ${n + 1}: the pack index is not on the quantity it qualifies`);

      // A caption sits 8pt above its value in the same column — that is what
      // makes it a field rather than two runs that happen to be near each other.
      assert.equal(value.x, caption.x, `page ${n + 1}: the marker's caption and value are not in one column`);
      assert.ok(Math.abs((value.top - caption.top) - 8) < 0.01,
        `page ${n + 1}: the marker's value is ${(value.top - caption.top).toFixed(2)}pt below its caption, not 8`);

      // And it is in the field band, not below the code.
      assert.ok(caption.x < qr.left - 4 * qr.cell,
        `page ${n + 1}: the marker is not in the column left of the code`);
    }
  }
});

test('an unsplit label still has nothing in the column under the QR', async () => {
  /* The quiet zone below is only ever at risk on a split label; this is what
     says so, and what would notice if something else were ever set there.

     "Under" means under the code's own column, not merely lower down the page.
     The fields wrap onto a second row once there are more than three of them,
     and that row sits below the code's bottom edge while staying well to the
     left of it — which is clear of the quiet zone, a two-dimensional region.
     The both-stocks test further down measures it as one. */
  const doc = ruler();
  const pdf = await buildLabelPdf([{ ...split, moq: null }]);
  const fonts = pageFonts(pdf);
  const [page] = pageDraws(pdf);
  const qr = drawnQr(page);
  const quiet = 4 * qr.cell;
  for (const t of page.texts) {
    if (t.top <= qr.bottom) continue;                       // beside or above the code
    if (inkRight(doc, fonts, t) <= qr.left - quiet) continue; // left of the code's column
    assert.ok(t.top >= qr.bottom + quiet,
      `${JSON.stringify(t.text)} is ${((t.top - qr.bottom) / qr.cell).toFixed(2)} modules below the code`);
  }
});

test('nothing set beside the QR reaches into its quiet zone either', async () => {
  /* The other three sides. The field row is the one that mattered: its three
     columns were pitched a flat 78pt apart from x=14, so GRN DATE's caption
     and value began at x=170, and a DD-Mon-YYYY value is up to 50.4pt of
     Helvetica-Bold 8.5 drawn with no width to stop it — ink to x≈220 against a
     code whose left edge is 217.5. That is not a quiet-zone violation but the
     symbol itself: at 29 and 33 modules the overrun inked four modules that
     should have been white, on every label printed, split or not.

     So this measures where each run's ink actually ends rather than trusting
     the option it was drawn with — the old row passed a `lineBreak: false`
     that reads like a clip and is not one. */
  const doc = ruler();
  for (const { modules, invoice } of QUIET_CASES) {
    for (const moq of [300, null]) {
      const pdf = await buildLabelPdf([{ ...split, moq, invoice_no: invoice }]);
      const fonts = pageFonts(pdf);

      for (const [n, page] of pageDraws(pdf).entries()) {
        const qr = drawnQr(page);
        const quiet = 4 * qr.cell;
        assert.equal(Math.round(56 / qr.cell), modules,
          `page ${n + 1}: a ${invoice.length}-character invoice should draw a ${modules}-module code`);

        for (const t of page.texts) {
          // Runs wholly above or wholly below the band are the vertical
          // tests' business; these are the ones set alongside the code.
          if (t.foot < qr.top - quiet + 0.001) continue;
          if (t.top > qr.bottom + quiet - 0.001) continue;

          const right = inkRight(doc, fonts, t);
          assert.ok(right <= qr.left - quiet + 0.001,
            `${modules} modules, page ${n + 1}: ${JSON.stringify(t.text)} reaches `
            + `${right.toFixed(2)}pt, leaving ${((qr.left - right) / qr.cell).toFixed(2)} `
            + `modules of white before the code at ${qr.left.toFixed(2)}pt, not four`);
        }
      }
    }
  }
});

test('an over-long part number is cut, not wrapped down across the label', async () => {
  /* PART_RE in grnImport.js allows 40 characters, and the label bounded the
     part number with a `width` — which is not a clip. PDFKit treats a width as
     a *wrap* width, and `lineBreak: false` only stops it defaulting that width
     to the page, so 369pt of Helvetica-Bold 16 came out as three stacked lines
     of part number stepping down over the fields, the code and the barcode.
     The description behaved the same way, under a 52-character slice that is a
     proxy for a width rather than a width. */
  const part = '90210-ABX-BRACKET-FRONT-LH-REV12-A/B.012';
  assert.equal(part.length, 40, 'this is meant to be the longest PART_RE admits');
  const desc = 'Front bumper mounting bracket, left hand, revision 12, powder coated';

  const doc = ruler();
  const pdf = await buildLabelPdf([{ ...split, moq: null, part_no: part, part_desc: desc }]);
  const fonts = pageFonts(pdf);
  const [page] = pageDraws(pdf);
  const qr = drawnQr(page);

  const heading = page.texts.filter((t) => t.size === 16);
  assert.equal(heading.length, 1,
    `the part number was drawn on ${heading.length} lines: ${JSON.stringify(heading.map((t) => t.text))}`);
  const description = page.texts.filter((t) => t.size === 7.5);
  assert.equal(description.length, 1,
    `the description was drawn on ${description.length} lines: ${JSON.stringify(description.map((t) => t.text))}`);

  assert.ok(heading[0].text.endsWith('…'),
    `a 369pt part number on a 283.5pt page should say it was cut: ${JSON.stringify(heading[0].text)}`);
  assert.ok(part.startsWith(heading[0].text.slice(0, -1)),
    'what is printed must be a prefix of the part number, not some other string');

  for (const t of [...heading, ...description]) {
    assert.ok(inkRight(doc, fonts, t) <= qr.left - 4 * qr.cell + 0.001,
      `${JSON.stringify(t.text)} reaches into the code's quiet zone`);
  }
});

/* ---- and the same, on the other stock ----------------------------------- */

/**
 * The two stocks a Supervisor can pick from Config, and what each carries.
 *
 * Everything above this point measures the 100×60 default. The 70×40 is two
 * thirds of the height and had never been measured at all: its three fields
 * were pitched the same flat 78pt apart, which put the third one at x=170 on a
 * 198.4pt page — off the sheet — and its footer line landed 1.4pt under the
 * code, inside the quiet zone, on every label.
 *
 * `rows` is how many rows the fields wrap onto, which follows from the page
 * rather than being set per stock. It is spelled out here so that a change to
 * it is a change to this table.
 */
const STOCKS = [
  { template: 'SPD Standard 100×60', W: 283.5, H: 170.1, rows: 1 },
  { template: 'SPD Compact 70×40', W: 198.4, H: 113.4, rows: 2 },
];

/** Boxes touch rather than collide when they share an edge, so allow for that. */
const EPS = 0.001;
const overlaps = (a, b) => a.left < b.right - EPS && a.right > b.left + EPS
  && a.top < b.bottom - EPS && a.bottom > b.top + EPS;

/**
 * Every piece of ink on the page as a named box, in label coordinates.
 *
 * The QR is left out: it is the thing everything else is measured against, and
 * it comes back from `drawnQr` inflated by its own quiet zone instead.
 */
function inkBoxes(page, fonts, doc, stock) {
  const boxes = page.texts.map((t) => ({
    what: JSON.stringify(t.text),
    left: t.x, right: inkRight(doc, fonts, t), top: t.top, bottom: t.foot,
  }));
  return boxes;
}

/**
 * Anything drawn in the shape of a barcode bar: a rect taller than a hairline
 * that is not square (QR modules are) and not the brand ribbon.
 */
function drawnBars(page) {
  return page.rects.filter((r) => r.h > 5 && r.w !== r.h && !(r.x === 0 && r.w === 5));
}

/** The code's quiet zone as a box: four modules out from the drawn modules. */
function quietZone(page) {
  const qr = drawnQr(page);
  const q = 4 * qr.cell;
  return {
    what: 'the QR’s quiet zone', cell: qr.cell,
    left: qr.left - q, right: qr.right + q, top: qr.top - q, bottom: qr.bottom + q,
  };
}

/** Both stocks, split and not, at every version the encoder emits. */
async function everyLabel(stock, fn) {
  const doc = ruler();
  for (const { modules, invoice } of QUIET_CASES) {
    for (const moq of [300, null]) {
      const pdf = await buildLabelPdf(
        [{ ...split, moq, invoice_no: invoice }], { template: stock.template },
      );
      const fonts = pageFonts(pdf);
      for (const [n, page] of pageDraws(pdf, stock.H).entries()) {
        const zone = quietZone(page);
        assert.equal(Math.round(56 / zone.cell), modules,
          `${stock.template} page ${n + 1}: expected a ${modules}-module code`);
        fn({
          stock, page, zone, modules, moq,
          boxes: inkBoxes(page, fonts, doc, stock),
          where: `${stock.template}, ${modules} modules, ${moq ? `split page ${n + 1}` : 'unsplit'}`,
        });
      }
    }
  }
}

test('the QR keeps four modules of white on all four sides, on both stocks', async () => {
  /* The three tests above measure the default stock one side at a time. This
     is the whole rule on both: nothing the label draws may enter the band of
     white a scanner needs to find the symbol, and the band has to be on the
     paper — a quiet zone running off the edge of the label is not a quiet
     zone. */
  for (const stock of STOCKS) {
    await everyLabel(stock, ({ zone, boxes, where }) => {
      assert.ok(zone.top >= -EPS && zone.left >= -EPS,
        `${where}: the quiet zone starts off the sheet at ${zone.left.toFixed(2)},${zone.top.toFixed(2)}`);
      assert.ok(zone.right <= stock.W + EPS && zone.bottom <= stock.H + EPS,
        `${where}: the quiet zone runs off the sheet at ${zone.right.toFixed(2)},${zone.bottom.toFixed(2)}`);

      for (const box of boxes) {
        assert.ok(!overlaps(box, zone),
          `${where}: ${box.what} at ${fmtBox(box)} is inside the quiet zone ${fmtBox(zone)}`);
      }
    });
  }
});

test('and nothing the label draws lands on anything else it draws', async () => {
  /* The quiet zone is the rule that matters to a scanner; this is the one that
     matters to a person. Both failures the 70×40 stock had were of this shape
     — a footer line printed over the code, fields printed off the sheet — and
     neither was visible to a test that only counted pages or read back text.

     It is also what keeps the layout honest as it is tuned: there is no way to
     know from reading the constants that the split marker, the fields and the
     wordmark all clear each other on the compact stock. */
  for (const stock of STOCKS) {
    await everyLabel(stock, ({ boxes, where }) => {
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          assert.ok(!overlaps(boxes[i], boxes[j]),
            `${where}: ${boxes[i].what} at ${fmtBox(boxes[i])} lands on `
            + `${boxes[j].what} at ${fmtBox(boxes[j])}`);
        }
      }
      for (const box of boxes) {
        assert.ok(box.left >= -EPS && box.right <= stock.W + EPS
          && box.top >= -EPS && box.bottom <= stock.H + EPS,
        `${where}: ${box.what} at ${fmtBox(box)} runs off a ${stock.W} × ${stock.H} sheet`);
      }
    });
  }
});

const fmtBox = (b) =>
  `x ${b.left.toFixed(1)}..${b.right.toFixed(1)} y ${b.top.toFixed(1)}..${b.bottom.toFixed(1)}`;

test('each stock wraps the fields onto as many rows as it has room for', async () => {
  /* Three fields in one row of 60.8pt columns on the 100×60, two rows of
     51.7pt columns on the 70×40 — which is the whole point of wrapping them
     rather than pitching them a fixed distance apart. A third of the compact
     stock's band is 32.5pt, and no arrangement of three columns there prints a
     date. */
  for (const stock of STOCKS) {
    const [page] = pageDraws(
      await buildLabelPdf([{ ...split, moq: null }], { template: stock.template }), stock.H,
    );
    const captionRows = new Set(page.texts.filter((t) => t.size === 6.5
      && ['INVOICE', 'QTY', 'GRN DATE'].includes(t.text)).map((t) => t.top.toFixed(3)));
    assert.equal(captionRows.size, stock.rows,
      `${stock.template}: the three fields took ${captionRows.size} row(s), expected ${stock.rows}`);

    assert.ok(page.texts.some((t) => t.text === 'SPD PRE-PACK'),
      `${stock.template}: the wordmark is missing`);
  }
});

test('the GRN date is never the field that gets abbreviated', async () => {
  /* Whatever else the row has to give up, the date is not it: an abbreviated
     date is a wrong date, not a shortened one, and it is the field a storeman
     reads to decide whether a pouch is still in its shelf life. The column is
     sized so the widest DD-Mon-YYYY the formatter can produce fits whole, and
     the invoice below is long enough to have taken the room if the columns
     shared it by content. */
  for (const stock of STOCKS) {
    for (let month = 0; month < 12; month++) {
      const grnDate = new Date(Date.UTC(2026, month, 5));
      const pages = pageTexts(await buildLabelPdf([{
        ...split, moq: null, grn_date: grnDate,
        invoice_no: 'INV-77003/2026-27/04-BLUEVOLT-MUMBAI-1',
      }], { template: stock.template }));
      const expected = `05-${MONTHS[month]}-2026`;
      assert.ok(pages[0].includes(expected),
        `${stock.template} prints no ${expected}: ${pages[0]}`);
    }
  }
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
