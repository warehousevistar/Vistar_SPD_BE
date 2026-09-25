import { tx } from '../db/index.js';
import { nextId } from './ids.js';
import { settings } from './settings.js';
import { audit } from './audit.js';
import { HttpError, badRequest, conflict, notFound } from '../middleware/error.js';

const nf = (n) => Number(n).toLocaleString('en-IN');

function durTxt(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/**
 * FR-6.1 — the member taps Start and the system records the time. Nothing about
 * the start is entered by hand, which is the whole point of replacing the paper
 * sheet.
 *
 * BR-05 is enforced here rather than in the route: the line must actually be
 * allocated to the member's own table.
 */
export async function startPacking({ lineId, memberId, tableNo }) {
  return tx(async (q) => {
    const [line] = await q(
      `SELECT l.*, s.status AS shift_status, s.label AS shift_label
         FROM grn_lines l JOIN shifts s ON s.id = l.shift_id
        WHERE l.id = $1 FOR UPDATE OF l`,
      [lineId],
    );
    if (!line) throw notFound('That GRN line no longer exists');
    if (line.shift_status === 'Finalised') {
      throw conflict(`${line.shift_label} has been finalised — the Supervisor must reopen it before any further entry (BR-06)`);
    }

    const [alloc] = await q('SELECT 1 FROM allocations WHERE line_id = $1 AND table_no = $2', [lineId, tableNo]);
    if (!alloc) throw new HttpError(403, `${line.part_no} is not allocated to ${tableNo} — you can only pack your own table's lines (BR-05)`);

    const [running] = await q(`SELECT id, line_id FROM packing_txns WHERE member_id = $1 AND status = 'Started'`, [memberId]);
    if (running) throw conflict(`You already have packing in progress (${running.id}) — submit it before starting another`);

    const [{ packed }] = await q(
      `SELECT COALESCE(SUM(qty), 0) AS packed FROM packing_txns WHERE line_id = $1 AND status <> 'Started'`,
      [lineId],
    );
    if (Number(packed) >= Number(line.grn_qty)) {
      throw conflict(`${line.part_no} is already fully packed against GRN quantity ${nf(line.grn_qty)}`);
    }

    const id = await nextId('packing_txns', 'TX', 4, q);
    const [row] = await q(
      `INSERT INTO packing_txns (id, line_id, table_no, member_id, start_at, status)
       VALUES ($1, $2, $3, $4, now(), 'Started') RETURNING *`,
      [id, lineId, tableNo, memberId],
    );
    await audit({
      actorId: memberId, action: 'Packing Start', reference: line.part_no,
      detail: `${tableNo} · start time auto-recorded`, before: '—', after: 'Started',
    }, q);
    return { txn: row, line };
  });
}

/**
 * FR-6.2/6.3/6.4 and BR-02/BR-03 — validates the quantity, stamps the submit
 * time, and flags an exception where the reconciliation rules say one is due.
 *
 * The whole thing runs in one transaction with `SELECT ... FOR UPDATE` on the
 * line, so two tables submitting against the same part at the same instant
 * cannot both read the old cumulative figure and both slip under the GRN
 * quantity (NFR-2.2).
 */
export async function submitPacking({ txnId, memberId, qty, pouches = 0, boxes = 0 }) {
  const cfg = await settings();

  // BR-02 — blank, zero, negative or non-numeric is rejected outright.
  const n = Number(qty);
  if (qty === null || qty === undefined || qty === '' || !Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw badRequest('Packed quantity must be a whole number greater than zero — blank, zero, negative or non-numeric entries are rejected (BR-02)');
  }
  const pou = Number(pouches) || 0;
  const box = Number(boxes) || 0;
  if (pou < 0 || box < 0 || !Number.isInteger(pou) || !Number.isInteger(box)) {
    throw badRequest('Pouches and boxes must be whole numbers of zero or more');
  }

  return tx(async (q) => {
    const [txn] = await q(`SELECT * FROM packing_txns WHERE id = $1 FOR UPDATE`, [txnId]);
    if (!txn) throw notFound('That packing transaction no longer exists');
    if (txn.member_id !== memberId) throw new HttpError(403, 'That transaction belongs to another member');
    // NFR-7.1 — a submitted transaction is immutable.
    if (txn.status !== 'Started') throw conflict(`${txn.id} was already submitted at ${new Date(txn.submit_at).toLocaleString('en-IN')} — corrections are recorded as a new transaction, never as an edit (NFR-7.1)`);

    const [line] = await q(
      `SELECT l.*, s.status AS shift_status, s.label AS shift_label
         FROM grn_lines l JOIN shifts s ON s.id = l.shift_id
        WHERE l.id = $1 FOR UPDATE OF l`,
      [txn.line_id],
    );
    if (line.shift_status === 'Finalised') {
      throw conflict(`${line.shift_label} has been finalised — entry is locked (BR-06)`);
    }

    const [row] = await q(
      `UPDATE packing_txns
          SET qty = $2, pouches = $3, boxes = $4, submit_at = now(), status = 'Submitted'
        WHERE id = $1 RETURNING *`,
      [txnId, n, pou, box],
    );

    const [{ packed }] = await q(
      `SELECT COALESCE(SUM(qty), 0) AS packed FROM packing_txns WHERE line_id = $1 AND status <> 'Started'`,
      [txn.line_id],
    );
    const cum = Number(packed);
    const grn = Number(line.grn_qty);

    /* FR-7.2 — two distinct flags, in the prototype's order of precedence:
       cumulative over GRN is an Excess Entry; otherwise a single submission
       above the configured share of the GRN quantity is an Abnormal Entry. */
    let exception = null;
    if (cum > grn) {
      exception = {
        type: 'Excess Entry',
        detail: `Cumulative packed ${nf(cum)} exceeds GRN quantity ${nf(grn)} for ${line.part_no} (${line.invoice_no}).`,
      };
    } else if (n > grn * cfg.threshold / 100 && n < grn) {
      exception = {
        type: 'Abnormal Entry',
        detail: `Single submission of ${nf(n)} is above the ${cfg.threshold}% abnormal-entry threshold of GRN qty ${nf(grn)} (${line.part_no}).`,
      };
    }

    if (exception) {
      const excId = await nextId('exceptions', 'EX', 3, q);
      await q(
        `INSERT INTO exceptions (id, txn_id, line_id, type, detail, created_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [excId, txnId, txn.line_id, exception.type, exception.detail],
      );
      await q(`UPDATE packing_txns SET status = 'Exception' WHERE id = $1`, [txnId]);
      row.status = 'Exception';
      exception.id = excId;
    }

    const elapsed = new Date(row.submit_at).getTime() - new Date(row.start_at).getTime();
    await audit({
      actorId: memberId, action: 'Packing Submit', reference: line.part_no,
      detail: `${line.invoice_no} · qty ${nf(n)} · ${pou} pouches · ${box} boxes · ${row.table_no} · ${durTxt(elapsed)}`,
      before: 'Started', after: row.status,
    }, q);

    return {
      txn: row,
      line: { ...line, packed: cum, pending: grn - cum },
      exception,
    };
  });
}

/**
 * What the member's screen needs before they submit: the warning text the
 * prototype shows live as the quantity is typed. Kept on the server so the
 * threshold that warns is the same one that flags (FR-7.2).
 */
export async function previewSubmission({ grnQty, packed, qty, threshold }) {
  const cum = Number(packed) + Number(qty);
  const grn = Number(grnQty);
  if (cum > grn) {
    return {
      tone: 'bad',
      title: 'Warning — exceeds GRN quantity',
      message: `Cumulative would be ${nf(cum)} vs GRN ${nf(grn)}. You can submit, but it will be flagged as an exception for the Supervisor (BR-03).`,
    };
  }
  if (Number(qty) > grn * threshold / 100) {
    return {
      tone: 'warn',
      title: `Above the ${threshold}% abnormal-entry threshold`,
      message: 'This submission will be flagged for Supervisor review (FR-7.2).',
    };
  }
  return { tone: 'ok', title: 'Looks good', message: `Pending after submit: ${nf(grn - cum)}.` };
}

export { nf, durTxt };
