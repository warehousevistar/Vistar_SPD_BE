-- ============================================================================
-- VST SPD — Pre-Packing Process Automation
-- PostgreSQL schema. Mirrors the SRS data dictionary (section 7) one table per
-- entity, with the business rules of section 10 enforced in constraints where
-- the database can hold them and in src/lib/ where they need context.
-- Every statement is IF NOT EXISTS so the file is safe to re-run on boot.
-- ============================================================================

/* ---------------------------------------------------------------- users ---
   Section 2.5 user classes. Table Members may sign in with a PIN rather than a
   password (NFR-3.1), so password_hash is nullable and pin_hash sits beside it.
*/
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  emp_code       TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('Supervisor','Member','Administrator','Management')),
  email          TEXT NOT NULL DEFAULT '',
  device         TEXT NOT NULL DEFAULT '',
  password_hash  TEXT,
  pin_hash       TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_emp_code_key ON users (emp_code);

/* -------------------------------------------------------- table master ---
   FR-4.3 / section 7 "Table Master". Status is derived from allocations rather
   than stored: a stored Free/Occupied/Completed drifts the moment a member
   submits, and the SRS wants it real time (FR-4.3).
*/
CREATE TABLE IF NOT EXISTS packing_tables (
  table_no   TEXT PRIMARY KEY,
  member_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

/* --------------------------------------------------------------- shifts ---
   BR-06: once status is 'Finalised', member data entry for the shift is locked
   until a Supervisor reopens it, and every reopen bumps resubmits.
*/
CREATE TABLE IF NOT EXISTS shifts (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  shift_date DATE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Finalised')),
  final_by   TEXT REFERENCES users(id),
  final_at   TIMESTAMPTZ,
  resubmits  INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ---------------------------------------------------------- GRN batches ---
   FR-1.5: one row per successful import, stamped with who uploaded it and when.
*/
CREATE TABLE IF NOT EXISTS grn_batches (
  id              TEXT PRIMARY KEY,
  file_name       TEXT NOT NULL,
  shift_id        TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by     TEXT REFERENCES users(id),
  row_count       INTEGER NOT NULL DEFAULT 0,
  rejected_count  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'Imported' CHECK (status IN ('Imported','Rejected','Replaced')),
  reupload_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS grn_batches_shift_idx ON grn_batches (shift_id);

/* ------------------------------------------------------------ GRN lines ---
   One part number per invoice inside a batch — the "line" counted in the MIS
   (section 1.4). grn_qty is the reconciliation base for BR-01.
*/
CREATE TABLE IF NOT EXISTS grn_lines (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES grn_batches(id) ON DELETE CASCADE,
  shift_id    TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  invoice_no  TEXT NOT NULL,
  part_no     TEXT NOT NULL,
  part_desc   TEXT NOT NULL DEFAULT '',
  uom         TEXT NOT NULL DEFAULT 'NOS',
  grn_qty     NUMERIC(14,2) NOT NULL CHECK (grn_qty > 0),
  vendor      TEXT NOT NULL DEFAULT '',
  grn_date    DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grn_lines_shift_idx   ON grn_lines (shift_id);
CREATE INDEX IF NOT EXISTS grn_lines_invoice_idx ON grn_lines (invoice_no);
CREATE INDEX IF NOT EXISTS grn_lines_part_idx    ON grn_lines (part_no);

/* ---------------------------------------------------------- allocations ---
   FR-4.1 / BR-04. qty NULL means the whole line went to one table; a split
   writes one row per table and both rows must carry the same reason.
*/
CREATE TABLE IF NOT EXISTS allocations (
  id            TEXT PRIMARY KEY,
  line_id       TEXT NOT NULL REFERENCES grn_lines(id) ON DELETE CASCADE,
  table_no      TEXT NOT NULL REFERENCES packing_tables(table_no) ON DELETE CASCADE,
  qty           NUMERIC(14,2) CHECK (qty IS NULL OR qty > 0),
  reason        TEXT NOT NULL DEFAULT '',
  allocated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  allocated_by  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS allocations_line_idx  ON allocations (line_id);
CREATE INDEX IF NOT EXISTS allocations_table_idx ON allocations (table_no);
-- BR-04: the same line cannot land on the same table twice.
CREATE UNIQUE INDEX IF NOT EXISTS allocations_line_table_key ON allocations (line_id, table_no);

/* ------------------------------------------------- packing transactions ---
   The core operational record: one row per Start/Submit pair (section 7).
   NFR-7.1 — a submitted row is never rewritten; a correction is a new row.
*/
CREATE TABLE IF NOT EXISTS packing_txns (
  id         TEXT PRIMARY KEY,
  line_id    TEXT NOT NULL REFERENCES grn_lines(id) ON DELETE CASCADE,
  table_no   TEXT NOT NULL REFERENCES packing_tables(table_no),
  member_id  TEXT NOT NULL REFERENCES users(id),
  start_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submit_at  TIMESTAMPTZ,
  qty        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  pouches    INTEGER NOT NULL DEFAULT 0 CHECK (pouches >= 0),
  boxes      INTEGER NOT NULL DEFAULT 0 CHECK (boxes >= 0),
  status     TEXT NOT NULL DEFAULT 'Started' CHECK (status IN ('Started','Submitted','Exception')),
  -- A submitted row must carry its submit time; a running one must not.
  CONSTRAINT packing_txns_submit_consistent
    CHECK ((status = 'Started' AND submit_at IS NULL) OR (status <> 'Started' AND submit_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS packing_txns_line_idx   ON packing_txns (line_id);
CREATE INDEX IF NOT EXISTS packing_txns_member_idx ON packing_txns (member_id);
CREATE INDEX IF NOT EXISTS packing_txns_table_idx  ON packing_txns (table_no);
-- FR-6.1: one member runs one activity at a time, so a second Start while one
-- is open is a data error rather than a second job.
CREATE UNIQUE INDEX IF NOT EXISTS packing_txns_one_running_per_member
  ON packing_txns (member_id) WHERE status = 'Started';

/* -------------------------------------------------------- exception log ---
   FR-7.2 / BR-03. remarks must be filled before a shift can be finalised; the
   check lives in the finalise handler because it is a cross-row rule.
*/
CREATE TABLE IF NOT EXISTS exceptions (
  id          TEXT PRIMARY KEY,
  txn_id      TEXT REFERENCES packing_txns(id) ON DELETE CASCADE,
  line_id     TEXT NOT NULL REFERENCES grn_lines(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('Excess Entry','Abnormal Entry','Quantity Mismatch','Manual Override')),
  detail      TEXT NOT NULL DEFAULT '',
  remarks     TEXT NOT NULL DEFAULT '',
  resolved_by TEXT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exceptions_line_idx ON exceptions (line_id);

/* ------------------------------------------------------ hourly reports ----
   FR-8.3: retained for on-demand viewing in addition to the email.
*/
CREATE TABLE IF NOT EXISTS hourly_reports (
  id               TEXT PRIMARY KEY,
  shift_id         TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  packed_qty       NUMERIC(14,2) NOT NULL DEFAULT 0,
  pending_qty      NUMERIC(14,2) NOT NULL DEFAULT 0,
  tables_summary   TEXT NOT NULL DEFAULT '',
  exceptions_count INTEGER NOT NULL DEFAULT 0,
  emailed_to       TEXT NOT NULL DEFAULT '',
  email_status     TEXT NOT NULL DEFAULT 'Recorded',
  body_json        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS hourly_reports_shift_idx ON hourly_reports (shift_id);

/* --------------------------------------------------------- MIS snapshots --
   FR-10.1: written automatically on the Supervisor's final submission.
*/
CREATE TABLE IF NOT EXISTS mis_snapshots (
  id           TEXT PRIMARY KEY,
  shift_id     TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lines_packed INTEGER NOT NULL DEFAULT 0,
  pouches      INTEGER NOT NULL DEFAULT 0,
  boxes        INTEGER NOT NULL DEFAULT 0,
  packed_qty   NUMERIC(14,2) NOT NULL DEFAULT 0,
  pending_qty  NUMERIC(14,2) NOT NULL DEFAULT 0,
  provisional  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS mis_snapshots_shift_idx ON mis_snapshots (shift_id);

/* ------------------------------------------------------- label print log --
   FR-3.3 / BR-09: a reprint must carry a reason, and both are audit-logged.
*/
CREATE TABLE IF NOT EXISTS labels_printed (
  id         BIGSERIAL PRIMARY KEY,
  line_id    TEXT NOT NULL REFERENCES grn_lines(id) ON DELETE CASCADE,
  copies     INTEGER NOT NULL DEFAULT 1 CHECK (copies > 0),
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  printed_by TEXT REFERENCES users(id),
  reason     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS labels_printed_line_idx ON labels_printed (line_id);

/* ------------------------------------------------------------ audit log ---
   NFR-3.3 / NFR-7.1. Append-only by convention: nothing in the API updates or
   deletes a row here.
*/
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     TEXT,
  action       TEXT NOT NULL,
  reference    TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '',
  before_value TEXT NOT NULL DEFAULT '',
  after_value  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx     ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action);

/* --------------------------------------------------------- app config -----
   FR-13.2 / NFR-5.1 / NFR-6.1: thresholds, intervals, the distribution list,
   the label template and the GRN column mapping — changed without a release.
*/
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
