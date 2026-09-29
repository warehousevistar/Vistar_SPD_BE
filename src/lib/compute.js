import { all, get } from '../db/index.js';

/* ============================================================================
   Reconciliation engine — section 4.7 and the business rules of section 10.

   Everything here derives from the transaction rows; nothing is a stored
   running total. BR-01 (Pending = GRN − cumulative Packed) then holds by
   construction, which is what NFR-7.2 asks for: any two screens computing it
   at the same moment agree, because there is only one place it is computed.

   'Started' rows are excluded from packed quantity throughout — a member who
   has begun but not submitted has packed nothing yet, exactly as the prototype
   treats it.
   ========================================================================== */

/** Packed quantity per line, as a subquery usable in a join. */
const PACKED_SQL = `
  SELECT t.line_id,
         COALESCE(SUM(t.qty), 0)     AS packed,
         COALESCE(SUM(t.pouches), 0) AS pouches,
         COALESCE(SUM(t.boxes), 0)   AS boxes,
         COUNT(*)                    AS txns
    FROM packing_txns t
   WHERE t.status <> 'Started'
   GROUP BY t.line_id`;

/**
 * Line status, matching the prototype's lineStatus() precedence exactly:
 * an open exception outranks everything, then fully packed, then any packed
 * quantity or a running transaction, then allocated, then pending.
 */
export function lineStatus({ grn_qty, packed, open_exceptions, running, allocations }) {
  if (Number(open_exceptions) > 0) return 'Exception';
  if (Number(packed) >= Number(grn_qty)) return 'Completed';
  if (Number(packed) > 0 || Number(running) > 0) return 'In Progress';
  return Number(allocations) > 0 ? 'Allocated' : 'Pending';
}

/**
 * Every GRN line of a shift with its live packed/pending figures, the tables it
 * sits on and its computed status. This one query backs the Lines screen, the
 * dashboard's invoice/part table and the part-wise MIS view.
 */
export async function shiftLines(shiftId, { invoice = '', vendor = '', status = '', q = '', tableNo = '', memberId = '' } = {}) {
  const rows = await all(
    `SELECT l.*,
            COALESCE(p.packed, 0)   AS packed,
            COALESCE(p.pouches, 0)  AS pouches,
            COALESCE(p.boxes, 0)    AS boxes,
            COALESCE(p.txns, 0)     AS txns,
            COALESCE(x.open_exceptions, 0) AS open_exceptions,
            COALESCE(r.running, 0)  AS running,
            COALESCE(a.tables, ARRAY[]::text[]) AS tables,
            COALESCE(a.n, 0)        AS allocations,
            COALESCE(lp.copies, 0)  AS label_copies,
            COALESCE(m.members, ARRAY[]::text[]) AS member_ids
       FROM grn_lines l
       LEFT JOIN (${PACKED_SQL}) p ON p.line_id = l.id
       LEFT JOIN (SELECT line_id, ARRAY_AGG(DISTINCT member_id) AS members
                    FROM packing_txns WHERE status <> 'Started' GROUP BY line_id) m
              ON m.line_id = l.id
       LEFT JOIN (SELECT line_id, COUNT(*) AS open_exceptions FROM exceptions WHERE resolved_at IS NULL GROUP BY line_id) x
              ON x.line_id = l.id
       LEFT JOIN (SELECT line_id, COUNT(*) AS running FROM packing_txns WHERE status = 'Started' GROUP BY line_id) r
              ON r.line_id = l.id
       LEFT JOIN (SELECT line_id, ARRAY_AGG(table_no ORDER BY table_no) AS tables, COUNT(*) AS n
                    FROM allocations GROUP BY line_id) a
              ON a.line_id = l.id
       LEFT JOIN (SELECT line_id, SUM(copies) AS copies FROM labels_printed GROUP BY line_id) lp
              ON lp.line_id = l.id
      WHERE l.shift_id = $1
      ORDER BY l.invoice_no, l.id`,
    [shiftId],
  );

  const Q = q.trim().toUpperCase();
  return rows
    .map((l) => ({
      ...l,
      pending: Number(l.grn_qty) - Number(l.packed),
      status: lineStatus(l),
    }))
    .filter((l) => !invoice || l.invoice_no === invoice)
    .filter((l) => !vendor || l.vendor === vendor)
    .filter((l) => !status || l.status === status)
    .filter((l) => !tableNo || l.tables.includes(tableNo))
    .filter((l) => !Q || l.part_no.toUpperCase().includes(Q) || l.part_desc.toUpperCase().includes(Q) || l.invoice_no.toUpperCase().includes(Q))
    .filter((l) => !memberId || l.member_ids.includes(memberId));
}

/** One line with the same derived fields, or null. */
export async function lineById(lineId) {
  const rows = await all(
    `SELECT l.*,
            COALESCE(p.packed, 0)  AS packed,
            COALESCE(p.pouches, 0) AS pouches,
            COALESCE(p.boxes, 0)   AS boxes,
            COALESCE(p.txns, 0)    AS txns,
            COALESCE(x.open_exceptions, 0) AS open_exceptions,
            COALESCE(r.running, 0) AS running,
            COALESCE(a.tables, ARRAY[]::text[]) AS tables,
            COALESCE(a.n, 0)       AS allocations,
            -- BR-09: the label dialog decides whether to demand a reprint
            -- reason from this. Leaving it out made every line look unprinted,
            -- so the dialog never asked and the print was then refused.
            COALESCE(lp.copies, 0) AS label_copies
       FROM grn_lines l
       LEFT JOIN (${PACKED_SQL}) p ON p.line_id = l.id
       LEFT JOIN (SELECT line_id, COUNT(*) AS open_exceptions FROM exceptions WHERE resolved_at IS NULL GROUP BY line_id) x ON x.line_id = l.id
       LEFT JOIN (SELECT line_id, COUNT(*) AS running FROM packing_txns WHERE status = 'Started' GROUP BY line_id) r ON r.line_id = l.id
       LEFT JOIN (SELECT line_id, ARRAY_AGG(table_no ORDER BY table_no) AS tables, COUNT(*) AS n FROM allocations GROUP BY line_id) a ON a.line_id = l.id
       LEFT JOIN (SELECT line_id, SUM(copies) AS copies FROM labels_printed GROUP BY line_id) lp ON lp.line_id = l.id
      WHERE l.id = $1`,
    [lineId],
  );
  if (!rows.length) return null;
  const l = rows[0];
  return { ...l, pending: Number(l.grn_qty) - Number(l.packed), status: lineStatus(l) };
}

/** Headline figures for a shift — the dashboard tiles and the MIS metrics. */
export async function shiftStats(shiftId) {
  const row = await get(
    `WITH lines AS (SELECT * FROM grn_lines WHERE shift_id = $1),
          packed AS (
            SELECT t.line_id,
                   SUM(t.qty)     AS qty,
                   SUM(t.pouches) AS pouches,
                   SUM(t.boxes)   AS boxes,
                   COUNT(*)       AS txns
              FROM packing_txns t
              JOIN lines l ON l.id = t.line_id
             WHERE t.status <> 'Started'
             GROUP BY t.line_id)
     SELECT (SELECT COUNT(*)::int FROM lines)                                         AS lines,
            (SELECT COALESCE(SUM(grn_qty), 0) FROM lines)                             AS grn,
            (SELECT COALESCE(SUM(qty), 0) FROM packed)                                AS packed,
            (SELECT COALESCE(SUM(pouches), 0)::int FROM packed)                       AS pouches,
            (SELECT COALESCE(SUM(boxes), 0)::int FROM packed)                         AS boxes,
            (SELECT COALESCE(SUM(txns), 0)::int FROM packed)                          AS txns,
            (SELECT COUNT(*)::int FROM lines l
               WHERE COALESCE((SELECT qty FROM packed p WHERE p.line_id = l.id), 0) >= l.grn_qty) AS lines_packed,
            (SELECT COUNT(*)::int FROM exceptions e JOIN lines l ON l.id = e.line_id) AS exc,
            (SELECT COUNT(*)::int FROM exceptions e JOIN lines l ON l.id = e.line_id
               WHERE e.resolved_at IS NULL)                                           AS exc_open`,
    [shiftId],
  );
  const grn = Number(row.grn);
  const packed = Number(row.packed);
  return {
    lines: row.lines,
    linesPacked: row.lines_packed,
    grn,
    packed,
    pending: grn - packed,           // BR-01
    pouches: row.pouches,
    boxes: row.boxes,
    exc: row.exc,
    excOpen: row.exc_open,
    txns: row.txns,
  };
}

/**
 * Table-wise productivity and occupancy (FR-4.3, FR-11.2).
 *
 * Status follows the prototype: a table with no allocation for this shift is
 * Free; one whose every allocated line is fully packed is Completed; otherwise
 * Occupied.
 */
export async function tableStats(shiftId) {
  return (await all(
    `SELECT pt.table_no,
            pt.member_id,
            u.name AS member_name,
            COALESCE(tx.qty, 0)::numeric     AS packed,
            COALESCE(tx.pouches, 0)::int     AS pouches,
            COALESCE(tx.boxes, 0)::int       AS boxes,
            COALESCE(tx.txns, 0)::int        AS txns,
            COALESCE(al.n, 0)::int           AS allocated_lines,
            COALESCE(al.done, 0)::int        AS completed_lines,
            COALESCE(al.grn, 0)::numeric     AS allocated_grn,
            COALESCE(al.packed, 0)::numeric  AS allocated_packed,
            COALESCE(tx.lines, 0)::int       AS lines
       FROM packing_tables pt
       LEFT JOIN users u ON u.id = pt.member_id
       LEFT JOIN (
         SELECT t.table_no, SUM(t.qty) AS qty, SUM(t.pouches) AS pouches, SUM(t.boxes) AS boxes,
                COUNT(*) AS txns, COUNT(DISTINCT t.line_id) AS lines
           FROM packing_txns t
           JOIN grn_lines l ON l.id = t.line_id
          WHERE t.status <> 'Started' AND l.shift_id = $1
          GROUP BY t.table_no) tx ON tx.table_no = pt.table_no
       LEFT JOIN (
         SELECT a.table_no,
                COUNT(*) AS n,
                SUM(l.grn_qty) AS grn,
                SUM(COALESCE(p.packed, 0)) AS packed,
                COUNT(*) FILTER (WHERE COALESCE(p.packed, 0) >= l.grn_qty) AS done
           FROM allocations a
           JOIN grn_lines l ON l.id = a.line_id
           LEFT JOIN (${PACKED_SQL}) p ON p.line_id = l.id
          WHERE l.shift_id = $1
          GROUP BY a.table_no) al ON al.table_no = pt.table_no
      WHERE pt.active
      ORDER BY pt.sort_order, pt.table_no`,
    [shiftId],
  )).map((t) => ({
    ...t,
    status: t.allocated_lines === 0 ? 'Free'
      : t.completed_lines >= t.allocated_lines ? 'Completed'
      : 'Occupied',
    pending: Math.max(0, Number(t.allocated_grn) - Number(t.allocated_packed)),
  }));
}

/** Member-wise productivity (FR-11.2) across the shift. */
export async function memberStats(shiftId) {
  return all(
    `SELECT u.id, u.name, u.emp_code, pt.table_no,
            COALESCE(s.txns, 0)::int      AS txns,
            COALESCE(s.qty, 0)::numeric   AS qty,
            COALESCE(s.pouches, 0)::int   AS pouches,
            COALESCE(s.boxes, 0)::int     AS boxes,
            COALESCE(s.lines, 0)::int     AS lines,
            s.last_submit
       FROM users u
       LEFT JOIN packing_tables pt ON pt.member_id = u.id
       LEFT JOIN (
         SELECT t.member_id, COUNT(*) AS txns, SUM(t.qty) AS qty, SUM(t.pouches) AS pouches,
                SUM(t.boxes) AS boxes, COUNT(DISTINCT t.line_id) AS lines, MAX(t.submit_at) AS last_submit
           FROM packing_txns t
           JOIN grn_lines l ON l.id = t.line_id
          WHERE t.status <> 'Started' AND l.shift_id = $1
          GROUP BY t.member_id) s ON s.member_id = u.id
      WHERE u.role = 'Member' AND u.active
      ORDER BY COALESCE(s.qty, 0) DESC, u.name`,
    [shiftId],
  );
}

/** Transactions of a shift, joined to their line — the MIS and export source. */
export async function shiftTxns(shiftId, { invoice = '', tableNo = '', memberId = '', lineId = '', includeRunning = false } = {}) {
  const params = [shiftId];
  const where = ['l.shift_id = $1'];
  if (!includeRunning) where.push(`t.status <> 'Started'`);
  if (invoice) { params.push(invoice); where.push(`l.invoice_no = $${params.length}`); }
  if (tableNo) { params.push(tableNo); where.push(`t.table_no = $${params.length}`); }
  if (memberId) { params.push(memberId); where.push(`t.member_id = $${params.length}`); }
  if (lineId) { params.push(lineId); where.push(`t.line_id = $${params.length}`); }
  return all(
    `SELECT t.*, l.invoice_no, l.part_no, l.part_desc, l.uom, l.grn_qty, l.vendor, l.grn_date,
            u.name AS member_name
       FROM packing_txns t
       JOIN grn_lines l ON l.id = t.line_id
       JOIN users u ON u.id = t.member_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.start_at DESC, t.id DESC`,
    params,
  );
}

