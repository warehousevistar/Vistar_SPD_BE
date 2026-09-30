/**
 * The database's own tests: the schema and the seed.
 *
 * Reading schema.sql tells you what the constraints are *meant* to say. It does
 * not tell you whether PostgreSQL agrees. A CHECK with a subtly wrong boolean,
 * a partial unique index whose WHERE clause never matches, a foreign key that
 * cascades where it should refuse — all of them read correctly and none of them
 * bite. So every rule the schema claims to enforce is proved here by handing
 * the database a row that breaks it and insisting on a refusal, with the
 * SQLSTATE and the constraint name checked so a test cannot pass because some
 * *other* rule happened to fire first.
 *
 * The seed is then checked as data: it is the fixture the whole demo rests on
 * and the reference the Flutter build is compared against, so it has to be
 * referentially sound, satisfy BR-01 on every line, contain exactly the one
 * deliberate over-pack the Review screen exists to show, and reproduce itself
 * exactly on a --reset.
 *
 * Everything runs against a scratch database (…_test), never the operational
 * one. If PostgreSQL is not reachable the whole file skips, so `npm run
 * test:unit` keeps its promise of needing no database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');

/* The same three parsers db/index.js installs. numeric and int8 arrive as
   strings otherwise, and every quantity comparison below would be a string
   comparison that quietly passes for the wrong reason. */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

/* ---- where to run ---------------------------------------------------- */

function configuredUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return 'postgresql://postgres:postgres@localhost:5432/vistar_spd';
}

const TEST_DB = process.env.SPD_TEST_DB || 'vistar_spd_test';
const testUrl = new URL(configuredUrl());
testUrl.pathname = `/${TEST_DB}`;
const adminUrl = new URL(configuredUrl());
adminUrl.pathname = '/postgres';

// The suite drops and recreates the public schema. That is only ever allowed to
// happen to a database whose name says it is scratch.
if (!TEST_DB.endsWith('_test')) {
  throw new Error(`refusing to run destructive schema tests against "${TEST_DB}" — the name must end in _test`);
}

let pool = null;
let skip = false;

try {
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (!rows.length) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: testUrl.href, max: 4 });
  await pool.query('SELECT 1');
} catch (err) {
  skip = `PostgreSQL not reachable (${err.code || err.message}) — schema tests skipped`;
  if (pool) { try { await pool.end(); } catch { /* never connected */ } pool = null; }
}

after(async () => { if (pool) await pool.end(); });

/* ---- probes ----------------------------------------------------------- */

/** Runs sql in a transaction that is always rolled back. Returns the error, or null if it was accepted. */
async function attempt(sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql, params);
    return null;
  } catch (err) {
    return err;
  } finally {
    try { await c.query('ROLLBACK'); } catch { /* already aborted */ }
    c.release();
  }
}

/** Asserts the database refuses the row, for the stated reason and no other. */
async function refuses(what, { sql, params = [], code, constraint }) {
  const err = await attempt(sql, params);
  assert.ok(err, `${what}: the database accepted it`);
  assert.equal(err.code, code, `${what}: expected SQLSTATE ${code}, got ${err.code} — ${err.message}`);
  if (constraint) {
    assert.equal(err.constraint, constraint,
      `${what}: refused by "${err.constraint}" rather than "${constraint}" — the wrong rule fired`);
  }
}

/** Asserts the database accepts the row (the mirror image: a rule must not over-reach). */
async function accepts(what, sql, params = []) {
  const err = await attempt(sql, params);
  assert.equal(err, null, `${what}: the database refused it — ${err && err.message}`);
}

const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const many = async (sql, params = []) => (await pool.query(sql, params)).rows;

/* ---- the fixture the constraint probes push against ------------------- */

const FIXTURE = `
  INSERT INTO users (id, name, emp_code, role) VALUES
    ('u.one', 'Member One', 'EMP-9001', 'Member'),
    ('u.two', 'Member Two', 'EMP-9002', 'Member');
  INSERT INTO packing_tables (table_no, member_id, sort_order) VALUES
    ('TT-01', 'u.one', 1), ('TT-02', 'u.two', 2);
  INSERT INTO shifts (id, label, shift_date) VALUES ('S-T', 'Scratch shift', '2026-09-29');
  INSERT INTO grn_batches (id, file_name, shift_id) VALUES ('B-T', 'scratch.xlsx', 'S-T');
  INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date) VALUES
    ('L-T', 'B-T', 'S-T', 'INV-T', 'PART-T', 100, '2026-09-29');
`;

before(async () => {
  if (skip) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});

/* ======================================================================= */
/* the schema applies                                                      */
/* ======================================================================= */

test('schema.sql applies to an empty database', { skip }, async () => {
  await pool.query(SCHEMA_SQL);
  const { n } = await one(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.equal(n, 14, 'the SRS section 7 data dictionary, plus qty_adjustments, is 14 tables');
});

test('schema.sql is idempotent — the server applies it on every boot', { skip }, async () => {
  await pool.query(FIXTURE);
  await pool.query(SCHEMA_SQL);             // second application
  await pool.query(SCHEMA_SQL);             // and a third, for good measure
  const { n } = await one('SELECT COUNT(*)::int AS n FROM grn_lines');
  assert.equal(n, 1, 're-applying the schema must not disturb existing rows');
});

test('every table the SRS data dictionary names exists', { skip }, async () => {
  /* The dictionary's thirteen, and qty_adjustments — which the SRS does not
     name because BR-01 assumes pending always closes by packing. It does not:
     a remainder that is damaged or short-shipped is written off instead, and
     that has to be a record with a reason rather than an edit to one of the
     other two terms. */
  const want = ['users', 'packing_tables', 'shifts', 'grn_batches', 'grn_lines', 'allocations',
    'packing_txns', 'exceptions', 'hourly_reports', 'mis_snapshots', 'labels_printed',
    'audit_log', 'app_config', 'qty_adjustments'];
  const got = (await many(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`))
    .map((r) => r.table_name);
  assert.deepEqual(got, [...want].sort());
});

test('every index the schema declares is actually present', { skip }, async () => {
  const want = ['users_emp_code_key', 'grn_batches_shift_idx', 'grn_lines_shift_idx',
    'grn_lines_invoice_idx', 'grn_lines_part_idx', 'allocations_line_idx', 'allocations_table_idx',
    'allocations_line_table_key', 'packing_txns_line_idx', 'packing_txns_member_idx',
    'packing_txns_table_idx', 'packing_txns_one_running_per_member', 'exceptions_line_idx',
    'hourly_reports_shift_idx', 'mis_snapshots_shift_idx', 'labels_printed_line_idx',
    'audit_log_at_idx', 'audit_log_action_idx', 'qty_adjustments_line_idx'];
  const got = new Set((await many(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`))
    .map((r) => r.indexname));
  for (const ix of want) assert.ok(got.has(ix), `index ${ix} is missing`);
  assert.equal(want.length, 19);
});

/* ======================================================================= */
/* the constraints bite                                                    */
/* ======================================================================= */

test('users.role accepts only the four SRS section 2.5 user classes', { skip }, async () => {
  await refuses('an invented role', {
    sql: `INSERT INTO users (id, name, emp_code, role) VALUES ('u.x', 'X', 'EMP-9. 9', 'Wizard')`,
    code: '23514', constraint: 'users_role_check',
  });
  for (const role of ['Supervisor', 'Member', 'Administrator', 'Management']) {
    await accepts(`the ${role} role`,
      `INSERT INTO users (id, name, emp_code, role) VALUES ('u.x', 'X', 'EMP-9999', $1)`, [role]);
  }
});

test('employee codes are unique — two people cannot share one', { skip }, async () => {
  await refuses('a duplicate emp_code', {
    sql: `INSERT INTO users (id, name, emp_code, role) VALUES ('u.dup', 'Dup', 'EMP-9001', 'Member')`,
    code: '23505', constraint: 'users_emp_code_key',
  });
});

test('shifts.status is Open or Finalised, nothing else (BR-06)', { skip }, async () => {
  await refuses('a third shift status', {
    sql: `INSERT INTO shifts (id, label, shift_date, status) VALUES ('S-X', 'X', '2026-09-29', 'Paused')`,
    code: '23514', constraint: 'shifts_status_check',
  });
});

test('grn_qty must be positive — BR-01 has no meaning from a zero base', { skip }, async () => {
  for (const [what, qty] of [['zero', 0], ['negative', -5]]) {
    await refuses(`a ${what} GRN quantity`, {
      sql: `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date)
            VALUES ('L-X', 'B-T', 'S-T', 'INV-X', 'PART-X', $1, '2026-09-29')`,
      params: [qty], code: '23514', constraint: 'grn_lines_grn_qty_check',
    });
  }
});

test('FR-3.5: an MOQ is either absent or positive', { skip }, async () => {
  for (const [what, moq] of [['zero', 0], ['negative', -300]]) {
    await refuses(`a ${what} MOQ`, {
      sql: `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date, moq)
            VALUES ('L-M', 'B-T', 'S-T', 'INV-M', 'PART-M', 350, '2026-09-29', $1)`,
      params: [moq], code: '23514', constraint: 'grn_lines_moq_check',
    });
  }
  await accepts('the 300-against-350 case the rule was written for',
    `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date, moq)
     VALUES ('L-M', 'B-T', 'S-T', 'INV-M', 'PART-M', 350, '2026-09-29', 300)`);
  await accepts('no MOQ at all, which is every line that predates the rule',
    `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date, moq)
     VALUES ('L-M', 'B-T', 'S-T', 'INV-M', 'PART-M', 350, '2026-09-29', NULL)`);
});

test('an MOQ that would print thousands of labels is refused by the database too', { skip }, async () => {
  // The import names the row first; this is the backstop. Without it a single
  // mistyped cell builds a PDF a page at a time until the process dies.
  await refuses('an MOQ of 1 against 400,000', {
    sql: `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date, moq)
          VALUES ('L-M', 'B-T', 'S-T', 'INV-M', 'PART-M', 400000, '2026-09-29', 1)`,
    code: '23514', constraint: 'grn_lines_moq_label_count',
  });
  await accepts('exactly the 500-label limit',
    `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date, moq)
     VALUES ('L-M', 'B-T', 'S-T', 'INV-M', 'PART-M', 500, '2026-09-29', 1)`);
});

test('a GRN line cannot exist without its batch, and dies with it', { skip }, async () => {
  await refuses('a line pointing at no batch', {
    sql: `INSERT INTO grn_lines (id, batch_id, shift_id, invoice_no, part_no, grn_qty, grn_date)
          VALUES ('L-X', 'B-NOPE', 'S-T', 'INV-X', 'PART-X', 5, '2026-09-29')`,
    code: '23503', constraint: 'grn_lines_batch_id_fkey',
  });

  // The cascade: deleting a mis-imported batch must take its lines with it,
  // which is what DELETE /grn/batches/:id relies on.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM grn_batches WHERE id = 'B-T'`);
    const { rows } = await c.query(`SELECT COUNT(*)::int AS n FROM grn_lines WHERE batch_id = 'B-T'`);
    assert.equal(rows[0].n, 0, 'deleting a batch left its lines orphaned');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('BR-04: one line cannot be allocated to the same table twice', { skip }, async () => {
  await pool.query(
    `INSERT INTO allocations (id, line_id, table_no, qty, reason) VALUES ('AL-1', 'L-T', 'TT-01', NULL, '')`);

  await refuses('the same line on the same table again', {
    sql: `INSERT INTO allocations (id, line_id, table_no) VALUES ('AL-2', 'L-T', 'TT-01')`,
    code: '23505', constraint: 'allocations_line_table_key',
  });

  // …but the explicit split BR-04 allows must still go through.
  await accepts('the same line split onto a second table',
    `INSERT INTO allocations (id, line_id, table_no, qty, reason)
     VALUES ('AL-2', 'L-T', 'TT-02', 40, 'Split across two tables to meet the dispatch cut-off')`);
});

test('an allocated quantity is either absent or positive', { skip }, async () => {
  await refuses('a zero split quantity', {
    sql: `INSERT INTO allocations (id, line_id, table_no, qty) VALUES ('AL-3', 'L-T', 'TT-02', 0)`,
    code: '23514', constraint: 'allocations_qty_check',
  });
  await accepts('NULL, meaning the whole line went to one table',
    `INSERT INTO allocations (id, line_id, table_no, qty) VALUES ('AL-3', 'L-T', 'TT-02', NULL)`);
});

test('BR-02: packed quantities and counts are never negative', { skip }, async () => {
  const cases = [
    ['a negative quantity', 'qty', -1, 'packing_txns_qty_check'],
    ['a negative pouch count', 'pouches', -1, 'packing_txns_pouches_check'],
    ['a negative box count', 'boxes', -1, 'packing_txns_boxes_check'],
  ];
  for (const [what, col, value, constraint] of cases) {
    await refuses(what, {
      sql: `INSERT INTO packing_txns (id, line_id, table_no, member_id, ${col}, status, submit_at)
            VALUES ('TX-X', 'L-T', 'TT-01', 'u.one', $1, 'Submitted', now())`,
      params: [value], code: '23514', constraint,
    });
  }
});

test('a transaction carries a submit time exactly when it is submitted', { skip }, async () => {
  await refuses('a running transaction with a submit time', {
    sql: `INSERT INTO packing_txns (id, line_id, table_no, member_id, status, submit_at)
          VALUES ('TX-X', 'L-T', 'TT-01', 'u.one', 'Started', now())`,
    code: '23514', constraint: 'packing_txns_submit_consistent',
  });
  await refuses('a submitted transaction with no submit time', {
    sql: `INSERT INTO packing_txns (id, line_id, table_no, member_id, status)
          VALUES ('TX-X', 'L-T', 'TT-01', 'u.one', 'Submitted')`,
    code: '23514', constraint: 'packing_txns_submit_consistent',
  });
  await refuses('an exception transaction with no submit time', {
    sql: `INSERT INTO packing_txns (id, line_id, table_no, member_id, status)
          VALUES ('TX-X', 'L-T', 'TT-01', 'u.one', 'Exception')`,
    code: '23514', constraint: 'packing_txns_submit_consistent',
  });
});

test('FR-6.1: a member runs one activity at a time', { skip }, async () => {
  await pool.query(
    `INSERT INTO packing_txns (id, line_id, table_no, member_id, status)
     VALUES ('TX-RUN', 'L-T', 'TT-01', 'u.one', 'Started')`);

  await refuses('a second Start for the same member', {
    sql: `INSERT INTO packing_txns (id, line_id, table_no, member_id, status)
          VALUES ('TX-RUN2', 'L-T', 'TT-01', 'u.one', 'Started')`,
    code: '23505', constraint: 'packing_txns_one_running_per_member',
  });

  // The index is partial, so it must not constrain anything else:
  await accepts('a second member starting at the same time',
    `INSERT INTO packing_txns (id, line_id, table_no, member_id, status)
     VALUES ('TX-RUN2', 'L-T', 'TT-02', 'u.two', 'Started')`);
  await accepts('the same member with a finished transaction alongside',
    `INSERT INTO packing_txns (id, line_id, table_no, member_id, status, submit_at, qty)
     VALUES ('TX-DONE', 'L-T', 'TT-01', 'u.one', 'Submitted', now(), 10)`);

  // NFR-7.1 keeps corrections as new rows, so many submitted rows must coexist.
  await accepts('a correction filed as a further submitted row',
    `INSERT INTO packing_txns (id, line_id, table_no, member_id, status, submit_at, qty) VALUES
       ('TX-D1', 'L-T', 'TT-01', 'u.one', 'Submitted', now(), 10),
       ('TX-D2', 'L-T', 'TT-01', 'u.one', 'Submitted', now(), 4)`);

  await pool.query(`DELETE FROM packing_txns WHERE id = 'TX-RUN'`);
});

test('a packing table with history cannot be deleted out from under it', { skip }, async () => {
  await pool.query(
    `INSERT INTO packing_txns (id, line_id, table_no, member_id, status, submit_at, qty)
     VALUES ('TX-KEEP', 'L-T', 'TT-01', 'u.one', 'Submitted', now(), 12)`);

  await refuses('deleting a table that has transactions', {
    sql: `DELETE FROM packing_tables WHERE table_no = 'TT-01'`,
    code: '23503', constraint: 'packing_txns_table_no_fkey',
  });
});

test('deactivating a member releases their table rather than deleting it', { skip }, async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM packing_txns WHERE member_id = 'u.two'`);
    await c.query(`DELETE FROM users WHERE id = 'u.two'`);
    const { rows } = await c.query(`SELECT member_id FROM packing_tables WHERE table_no = 'TT-02'`);
    assert.equal(rows.length, 1, 'the table itself must survive');
    assert.equal(rows[0].member_id, null, 'the table should have been released, not destroyed');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('exceptions.type accepts only the four FR-7 categories', { skip }, async () => {
  await refuses('an invented exception type', {
    sql: `INSERT INTO exceptions (id, line_id, type) VALUES ('EX-X', 'L-T', 'Something Odd')`,
    code: '23514', constraint: 'exceptions_type_check',
  });
  for (const type of ['Excess Entry', 'Abnormal Entry', 'Quantity Mismatch', 'Manual Override']) {
    await accepts(`the ${type} category`,
      `INSERT INTO exceptions (id, line_id, type) VALUES ('EX-X', 'L-T', $1)`, [type]);
  }
});

test('a label print is at least one copy', { skip }, async () => {
  await refuses('a print of zero copies', {
    sql: `INSERT INTO labels_printed (line_id, copies) VALUES ('L-T', 0)`,
    code: '23514', constraint: 'labels_printed_copies_check',
  });
});

test('app_config holds JSON, and one row per key', { skip }, async () => {
  await pool.query(`INSERT INTO app_config (key, value) VALUES ('k', '{"a":1}'::jsonb)`);
  await refuses('a second row for the same key', {
    sql: `INSERT INTO app_config (key, value) VALUES ('k', '{"a":2}'::jsonb)`,
    code: '23505', constraint: 'app_config_pkey',
  });
});

/* ======================================================================= */
/* the seed                                                                */
/* ======================================================================= */

let seedOut = '';

test('the seed loads into a clean database', { skip }, async () => {
  const res = spawnSync(process.execPath, ['src/db/seed.js', '--reset'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testUrl.href },
  });
  seedOut = `${res.stdout || ''}${res.stderr || ''}`;
  assert.equal(res.status, 0, `seed --reset failed:\n${seedOut}`);
});

test('the seed reports truthfully what it wrote', { skip }, async () => {
  // "[seed] 9 users · 8 tables · 42 GRN lines · 19 allocations · 31 transactions · 3 exception(s)"
  const m = seedOut.match(
    /(\d+) users · (\d+) tables · (\d+) GRN lines · (\d+) allocations · (\d+) transactions · (\d+) exception/);
  assert.ok(m, `the seed did not print its summary:\n${seedOut}`);
  const [, users, tables, lines, allocs, txns, excs] = m.map(Number);

  const actual = await one(`SELECT
      (SELECT COUNT(*)::int FROM users)          AS users,
      (SELECT COUNT(*)::int FROM packing_tables) AS tables,
      (SELECT COUNT(*)::int FROM grn_lines)      AS lines,
      (SELECT COUNT(*)::int FROM allocations)    AS allocs,
      (SELECT COUNT(*)::int FROM packing_txns)   AS txns,
      (SELECT COUNT(*)::int FROM exceptions)     AS excs`);

  assert.deepEqual(actual, { users, tables, lines, allocs, txns, excs },
    'the seed summary does not match what is in the database');

  // And the shape the approved prototype was signed off against.
  assert.deepEqual(actual, { users: 9, tables: 8, lines: 42, allocs: 19, txns: 31, excs: 3 });
});

test('nothing in the seed is orphaned', { skip }, async () => {
  const orphans = await many(`
    SELECT 'grn_lines.batch_id'    AS ref, COUNT(*)::int AS n FROM grn_lines l    LEFT JOIN grn_batches b    ON b.id = l.batch_id     WHERE b.id IS NULL
    UNION ALL SELECT 'grn_lines.shift_id',    COUNT(*)::int FROM grn_lines l      LEFT JOIN shifts s         ON s.id = l.shift_id     WHERE s.id IS NULL
    UNION ALL SELECT 'allocations.line_id',   COUNT(*)::int FROM allocations a    LEFT JOIN grn_lines l      ON l.id = a.line_id      WHERE l.id IS NULL
    UNION ALL SELECT 'allocations.table_no',  COUNT(*)::int FROM allocations a    LEFT JOIN packing_tables t ON t.table_no = a.table_no WHERE t.table_no IS NULL
    UNION ALL SELECT 'packing_txns.line_id',  COUNT(*)::int FROM packing_txns x   LEFT JOIN grn_lines l      ON l.id = x.line_id      WHERE l.id IS NULL
    UNION ALL SELECT 'packing_txns.member_id',COUNT(*)::int FROM packing_txns x   LEFT JOIN users u          ON u.id = x.member_id    WHERE u.id IS NULL
    UNION ALL SELECT 'packing_txns.table_no', COUNT(*)::int FROM packing_txns x   LEFT JOIN packing_tables t ON t.table_no = x.table_no WHERE t.table_no IS NULL
    UNION ALL SELECT 'exceptions.line_id',    COUNT(*)::int FROM exceptions e     LEFT JOIN grn_lines l      ON l.id = e.line_id      WHERE l.id IS NULL
    UNION ALL SELECT 'exceptions.txn_id',     COUNT(*)::int FROM exceptions e     LEFT JOIN packing_txns x   ON x.id = e.txn_id       WHERE e.txn_id IS NOT NULL AND x.id IS NULL
    UNION ALL SELECT 'labels_printed.line_id',COUNT(*)::int FROM labels_printed p LEFT JOIN grn_lines l      ON l.id = p.line_id      WHERE l.id IS NULL
    UNION ALL SELECT 'mis_snapshots.shift_id',COUNT(*)::int FROM mis_snapshots m  LEFT JOIN shifts s         ON s.id = m.shift_id     WHERE s.id IS NULL
    UNION ALL SELECT 'hourly_reports.shift_id',COUNT(*)::int FROM hourly_reports h LEFT JOIN shifts s        ON s.id = h.shift_id     WHERE s.id IS NULL`);
  const bad = orphans.filter((r) => r.n > 0);
  assert.deepEqual(bad, [], `dangling references: ${bad.map((r) => `${r.ref}×${r.n}`).join(', ')}`);
});

test('BR-01 holds on every seeded line: pending = GRN − packed', { skip }, async () => {
  const rows = await many(`
    SELECT l.id, l.grn_qty,
           COALESCE(SUM(t.qty) FILTER (WHERE t.status <> 'Started'), 0)::numeric AS packed
      FROM grn_lines l LEFT JOIN packing_txns t ON t.line_id = l.id
     GROUP BY l.id, l.grn_qty`);
  assert.equal(rows.length, 42);

  for (const r of rows) {
    assert.ok(Number.isFinite(r.packed), `${r.id}: packed is not a number`);
    assert.ok(r.grn_qty > 0, `${r.id}: a GRN quantity of ${r.grn_qty} would make pending meaningless`);
  }

  // A running transaction contributes nothing until it is submitted, which is
  // the whole reason packed is derived rather than stored.
  const running = await many(`SELECT id, line_id, qty FROM packing_txns WHERE status = 'Started'`);
  assert.equal(running.length, 1, 'the prototype shows exactly one activity in progress');
  assert.equal(running[0].qty, 0, 'a running transaction has no quantity yet');
});

test('the one deliberate over-pack is there, and it is flagged (BR-03)', { skip }, async () => {
  const over = await many(`
    SELECT l.id, l.grn_qty,
           COALESCE(SUM(t.qty) FILTER (WHERE t.status <> 'Started'), 0)::numeric AS packed
      FROM grn_lines l LEFT JOIN packing_txns t ON t.line_id = l.id
     GROUP BY l.id, l.grn_qty
    HAVING COALESCE(SUM(t.qty) FILTER (WHERE t.status <> 'Started'), 0) > l.grn_qty`);

  assert.equal(over.length, 1, 'the Review screen exists to show exactly one over-packed line');
  assert.equal(over[0].packed - over[0].grn_qty, 20, 'the prototype over-packs by 20');

  const exc = await one(
    `SELECT id, type, remarks, resolved_at FROM exceptions WHERE line_id = $1 AND type = 'Excess Entry'`,
    [over[0].id]);
  assert.ok(exc, `the over-pack on ${over[0].id} produced no Excess Entry`);
  assert.equal(exc.remarks, '', 'it must start unannotated — that is what blocks finalisation');
  assert.equal(exc.resolved_at, null);
});

test('every exception points at a real transaction on its own line', { skip }, async () => {
  const bad = await many(`
    SELECT e.id FROM exceptions e
      JOIN packing_txns t ON t.id = e.txn_id
     WHERE t.line_id <> e.line_id`);
  assert.deepEqual(bad, [], 'an exception is filed against a transaction on a different line');
});

test('BR-04: a split allocation carries its reason on every row', { skip }, async () => {
  const split = await many(`
    SELECT line_id, COUNT(*)::int AS n, MIN(reason) AS min_reason, MAX(reason) AS max_reason
      FROM allocations GROUP BY line_id HAVING COUNT(*) > 1`);
  assert.ok(split.length >= 1, 'the seed should demonstrate at least one BR-04 split');
  for (const s of split) {
    assert.notEqual(s.min_reason, '', `the split of ${s.line_id} has a row with no reason`);
    assert.equal(s.min_reason, s.max_reason, `the split of ${s.line_id} gives different reasons per row`);
  }

  // A whole-line allocation is the NULL-qty case, and must not carry a split reason.
  const whole = await one(
    `SELECT COUNT(*)::int AS n FROM allocations WHERE qty IS NULL`);
  assert.ok(whole.n > 0, 'the ordinary whole-line allocation should be the common case');
});

test('the finalised shift is locked and carries its MIS (BR-06, FR-10.1)', { skip }, async () => {
  const shift = await one(`SELECT * FROM shifts WHERE status = 'Finalised'`);
  assert.ok(shift, 'the seed should include one finalised shift to exercise BR-06');
  assert.ok(shift.final_by, 'a finalised shift records who finalised it');
  assert.ok(shift.final_at, 'a finalised shift records when');
  assert.equal(shift.resubmits, 1, 'the seed logs one reopen-and-resubmit');
  assert.equal(shift.shift_date, '2026-09-08',
    'shift_date must stay the string the column holds — a Date here shifts the day east of UTC');

  const mis = await one('SELECT * FROM mis_snapshots WHERE shift_id = $1', [shift.id]);
  assert.ok(mis, 'finalising must have written the MIS');
  assert.equal(mis.provisional, false, 'BR-07: the MIS of a finalised shift is not provisional');

  // The snapshot has to agree with the transactions it was taken from.
  const actual = await one(`
    SELECT COALESCE(SUM(t.qty), 0)::numeric     AS packed,
           COALESCE(SUM(t.pouches), 0)::int     AS pouches,
           COALESCE(SUM(t.boxes), 0)::int       AS boxes
      FROM packing_txns t JOIN grn_lines l ON l.id = t.line_id
     WHERE l.shift_id = $1 AND t.status <> 'Started'`, [shift.id]);
  assert.equal(mis.packed_qty, actual.packed, 'the MIS packed quantity does not match the transactions');
  assert.equal(mis.pouches, actual.pouches);
  assert.equal(mis.boxes, actual.boxes);

  const grn = await one(
    'SELECT COALESCE(SUM(grn_qty), 0)::numeric AS q FROM grn_lines WHERE shift_id = $1', [shift.id]);
  assert.equal(mis.pending_qty, grn.q - actual.packed, 'BR-01 must hold in the MIS too');
});

test('every seeded user can actually sign in', { skip }, async () => {
  const users = await many('SELECT id, role, password_hash, pin_hash, active FROM users');
  for (const u of users) {
    assert.ok(u.active, `${u.id} is seeded inactive and could not sign in`);
    assert.ok(u.password_hash, `${u.id} has no password hash`);
    if (u.role === 'Member') assert.ok(u.pin_hash, `${u.id} is a Member with no PIN (NFR-3.1)`);
  }
  assert.equal(users.filter((u) => u.role === 'Member').length, 6);
});

test('the reconciliation engine agrees with the seeded rows', { skip }, async () => {
  // compute.js is what every screen reads through. Pointing it at the scratch
  // database and comparing against plain SQL proves the seed and the engine
  // tell the same story — a mismatch here would show up as wrong numbers on
  // screen with nothing in the logs.
  process.env.DATABASE_URL = testUrl.href;
  const { shiftLines } = await import('../src/lib/compute.js');
  const db = await import('../src/db/index.js');

  const open = await one(`SELECT id FROM shifts WHERE status = 'Open'`);
  const lines = await shiftLines(open.id);
  const raw = await many(`
    SELECT l.id, l.grn_qty,
           COALESCE(SUM(t.qty) FILTER (WHERE t.status <> 'Started'), 0)::numeric AS packed
      FROM grn_lines l LEFT JOIN packing_txns t ON t.line_id = l.id
     WHERE l.shift_id = $1 GROUP BY l.id, l.grn_qty`, [open.id]);

  const byId = new Map(raw.map((r) => [r.id, r]));
  assert.equal(lines.length, raw.length);
  for (const line of lines) {
    const r = byId.get(line.id);
    assert.ok(r, `compute returned a line ${line.id} that is not in the shift`);
    assert.equal(Number(line.packed), Number(r.packed), `${line.id}: packed disagrees`);
    assert.equal(Number(line.pending), Number(r.grn_qty) - Number(r.packed), `${line.id}: BR-01 disagrees`);
  }
  await db.pool.end();
});

test('--reset reproduces the demo shift exactly', { skip }, async () => {
  const fingerprint = async () => one(`SELECT
      md5(COALESCE(string_agg(x, '|' ORDER BY x), '')) AS lines FROM (
        SELECT id||':'||invoice_no||':'||part_no||':'||grn_qty||':'||grn_date AS x FROM grn_lines) a`)
    .then(async (l) => ({
      lines: l.lines,
      ...(await one(`SELECT
          md5(COALESCE(string_agg(x, '|' ORDER BY x), '')) AS txns FROM (
            SELECT id||':'||line_id||':'||table_no||':'||member_id||':'||qty||':'||pouches||':'||boxes||':'||status AS x
              FROM packing_txns) a`)),
      ...(await one(`SELECT
          md5(COALESCE(string_agg(x, '|' ORDER BY x), '')) AS allocs FROM (
            SELECT id||':'||line_id||':'||table_no||':'||COALESCE(qty::text,'-')||':'||reason AS x
              FROM allocations) a`)),
    }));

  const before = await fingerprint();

  const res = spawnSync(process.execPath, ['src/db/seed.js', '--reset'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testUrl.href },
  });
  assert.equal(res.status, 0, `the second seed failed:\n${res.stdout}${res.stderr}`);

  const after = await fingerprint();
  assert.deepEqual(after, before,
    'the seed is not deterministic — the Flutter build can no longer be compared against the approved prototype');
});

test('FR-3.5: the seed demonstrates the split, and the rule agrees with the data', { skip }, async () => {
  const { labelUnits } = await import('../src/services/labels.js');

  const withMoq = await many(
    'SELECT id, part_no, grn_qty, moq FROM grn_lines WHERE moq IS NOT NULL ORDER BY part_no');
  assert.ok(withMoq.length >= 4, 'the demo should show more than one shape of split');

  /* The case the rule was written from: MOQ 300, GRN 350 → 300 then 50. Found
     by its quantities rather than by part number, because the same part is
     generated into both batches — each one restarts the parts pool — and the
     08-Sep copy carries a different GRN quantity. */
  const mfs = withMoq.find((l) => Number(l.grn_qty) === 350 && Number(l.moq) === 300);
  assert.ok(mfs, 'the seed no longer demonstrates the 350-against-300 split');
  assert.deepEqual(labelUnits(mfs).map((u) => u.label_qty), [300, 50]);

  // Every seeded MOQ must be one the database and the splitter both accept.
  for (const l of withMoq) {
    const units = labelUnits(l);
    const total = units.reduce((s, u) => s + u.label_qty, 0);
    assert.equal(Math.round(total * 100), Math.round(Number(l.grn_qty) * 100),
      `${l.part_no}: the labels do not add up to the GRN quantity`);
    assert.ok(units.length <= 500, `${l.part_no} would print ${units.length} labels`);
  }

  // 90210-ABX is the fixture the QR decoder is proved against, so it must stay
  // unsplit or that test is checking a payload nothing prints.
  const abx = await one(`SELECT moq FROM grn_lines WHERE part_no = '90210-ABX'`);
  assert.equal(abx.moq, null);
});

test('FR-3.5: lines without an MOQ still print exactly one label', { skip }, async () => {
  const { labelUnits } = await import('../src/services/labels.js');
  const plain = await many('SELECT id, grn_qty, moq FROM grn_lines WHERE moq IS NULL');
  assert.ok(plain.length > 30, 'most of the demo shift should be unsplit');
  for (const l of plain) {
    const units = labelUnits(l);
    assert.equal(units.length, 1, `${l.id} split without an MOQ`);
    assert.equal(units[0].label_qty, Number(l.grn_qty));
    assert.equal(units[0].label_of, 1);
  }
});
