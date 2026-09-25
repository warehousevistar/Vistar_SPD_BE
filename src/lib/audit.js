import { all, run } from '../db/index.js';

/**
 * NFR-3.3 / NFR-7.1 — every import, allocation, start/submit, exception
 * override, label reprint, configuration change and resubmission lands here
 * with user, timestamp and reason.
 *
 * Takes an optional `q` so a caller inside tx() writes the audit row in the
 * same transaction as the change it describes. A change that commits without
 * its audit row, or the reverse, is worse than either failing.
 */
export async function audit({ actorId, action, reference = '', detail = '', before = '', after = '', at = null }, q = null) {
  const sql = `INSERT INTO audit_log (at, actor_id, action, reference, detail, before_value, after_value)
               VALUES (COALESCE($1, now()), $2, $3, $4, $5, $6, $7)`;
  const params = [at, actorId ?? null, action, reference, detail, before, after];
  if (q) return q(sql, params);
  return run(sql, params);
}

/** Audit rows newest first, optionally filtered by action and free text. */
export async function auditRows({ action = '', q = '', limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (action) { params.push(action); where.push(`a.action = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(a.reference ILIKE $${params.length} OR a.detail ILIKE $${params.length})`);
  }
  params.push(limit);
  return all(
    `SELECT a.*, u.name AS actor_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  );
}
