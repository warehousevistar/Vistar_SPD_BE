import { all, run } from '../db/index.js';

/**
 * The Admin-editable parameters of FR-13.2. Defaults match the approved
 * prototype, so a fresh database behaves like the signed-off demo.
 */
export const DEFAULTS = {
  // FR-7.2 — % of GRN qty in a single submission that trips an abnormal entry.
  threshold: 50,
  // FR-8.1 — minutes between automated hourly reports.
  hourly: 60,
  // FR-11.4 — dashboard auto-refresh, seconds.
  refresh: 60,
  // FR-8.2 — distribution list for the hourly report.
  emails: ['rajesh.menon@vistarlogitek.com', 'spd.shiftreport@vistarlogitek.com'],
  // FR-3.4 — label template.
  labelTpl: 'SPD Standard 100×60',
  /* NFR-6.1 — the GRN import column mapping. Held as data, not code, so a
     change to the SAP export header is a configuration edit rather than a
     release. Each entry is the header the file is expected to carry; the
     importer matches case- and space-insensitively. */
  grnCols: ['Invoice No.', 'Part Number', 'Part Description', 'GRN Quantity', 'UOM', 'Vendor', 'GRN Date'],
};

let cache = null;

/** Current configuration, defaults merged with whatever is stored. */
export async function settings({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const rows = await all('SELECT key, value FROM app_config');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

/** Writes the supplied keys and invalidates the cache. Unknown keys are ignored. */
export async function saveSettings(patch, actorId) {
  const keys = Object.keys(patch).filter((k) => k in DEFAULTS);
  for (const k of keys) {
    await run(
      `INSERT INTO app_config (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [k, JSON.stringify(patch[k]), actorId ?? null],
    );
  }
  cache = null;
  return settings({ fresh: true });
}
