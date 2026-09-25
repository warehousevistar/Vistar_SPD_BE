import { get } from '../db/index.js';

const pad = (n, w) => String(n).padStart(w, '0');

/**
 * Next id in a `PREFIX0001` series, derived from what is already stored.
 *
 * A counter table would be tidier, but this keeps the ids human-readable and
 * stable across a restore: `TX0107` in a screenshot still points at the same
 * transaction after the database is rebuilt from a dump. The read and the
 * insert must run inside the same transaction for it to be safe under the
 * concurrent submissions of NFR-2.2 — every caller does.
 */
export async function nextId(table, prefix, width = 4, q = null) {
  const sql = `SELECT id FROM ${table} WHERE id LIKE $1 ORDER BY id DESC LIMIT 1`;
  const rows = q ? await q(sql, [`${prefix}%`]) : [await get(sql, [`${prefix}%`])].filter(Boolean);
  const last = rows[0]?.id;
  const n = last ? Number(String(last).slice(prefix.length)) || 0 : 0;
  return prefix + pad(n + 1, width);
}

/** GRN batch ids read as GRN-DDMM-NN, as in the prototype's import history. */
export async function nextBatchId(shiftDate, q = null) {
  const d = new Date(shiftDate);
  const stem = `GRN-${pad(d.getUTCDate(), 2)}${pad(d.getUTCMonth() + 1, 2)}-`;
  const sql = `SELECT id FROM grn_batches WHERE id LIKE $1 ORDER BY id DESC LIMIT 1`;
  const rows = q ? await q(sql, [`${stem}%`]) : [await get(sql, [`${stem}%`])].filter(Boolean);
  const n = rows[0]?.id ? Number(String(rows[0].id).slice(stem.length)) || 0 : 0;
  return stem + pad(n + 1, 2);
}

/** Line ids are allocated in a run during import, so the caller holds the seed. */
export function lineId(seq) {
  return 'L' + pad(seq, 4);
}

export { pad };
