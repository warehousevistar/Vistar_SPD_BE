import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* NUMERIC comes back from node-postgres as a string, because a PostgreSQL
   numeric can hold more precision than a JS double. Quantities here are at most
   a few hundred thousand with two decimals, well inside what a double holds
   exactly, and every consumer (JSON responses, arithmetic in lib/compute.js)
   wants a number. Parsing it once at the driver is what keeps the rest of the
   codebase free of `Number(row.grn_qty)` noise — and of the bugs that appear
   the one time somebody forgets it and string-concatenates two quantities. */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// int8 (BIGSERIAL ids) — same reasoning, and these stay small.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/* DATE (oid 1082) stays a 'YYYY-MM-DD' string rather than becoming a JS Date.
   A SQL date has no time and no zone; turning it into a Date gives it both, at
   *local* midnight, and every later `.toISOString()` then shifts it back a day
   for anyone east of UTC. That is not theoretical — it named the 9-Sep shift's
   MIS snapshot MIS-0908. The string is what the column actually holds, and it
   is what the API returns, formats and builds ids from. */
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  // A pooled client can die while idle (server restart, network blip). Without
  // this listener that surfaces as an unhandled 'error' event and takes the
  // process down mid-shift.
  console.error('[spd] idle pg client error:', err.message);
});

/* ---- thin helpers so route code never repeats pool.query(...).rows ---- */

/** All rows. */
export async function all(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

/** First row, or null. */
export async function get(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows[0] ?? null;
}

/** Row count / RETURNING row for writes. */
export async function run(sql, params = []) {
  const res = await pool.query(sql, params);
  return { rowCount: res.rowCount, row: res.rows[0] ?? null, rows: res.rows };
}

/**
 * Runs fn inside a transaction on one dedicated client and rolls back on throw.
 *
 * fn receives a `q(sql, params)` helper bound to that client. Using the pool
 * helpers above inside a transaction would silently run on a *different*
 * connection, outside the transaction — which is exactly the kind of bug that
 * only shows up under the concurrent submissions NFR-2.2 asks for.
 */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = async (sql, params = []) => (await client.query(sql, params)).rows;
    const out = await fn(q, client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Applies schema.sql. Idempotent — every statement in it is IF NOT EXISTS. */
export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

/** Verifies the database is reachable and reports the table row counts. */
export async function healthCounts() {
  const tables = ['users', 'packing_tables', 'shifts', 'grn_batches', 'grn_lines',
    'allocations', 'packing_txns', 'exceptions', 'hourly_reports', 'mis_snapshots', 'audit_log'];
  const counts = {};
  for (const t of tables) {
    const row = await get(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts[t] = row.n;
  }
  return counts;
}
