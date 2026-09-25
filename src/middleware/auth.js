import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { get } from '../db/index.js';
import { HttpError } from './error.js';

export function signToken(user, tableNo = null) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name, table: tableNo },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

/** Populates req.user (and req.tableNo for a Member), or 401s. */
export async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Authentication required'));

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(new HttpError(401, 'Session expired — please sign in again'));
  }

  try {
    const user = await get('SELECT * FROM users WHERE id = $1 AND active', [payload.sub]);
    if (!user) return next(new HttpError(401, 'User no longer active'));
    delete user.password_hash;
    delete user.pin_hash;

    req.user = user;
    /* A Member's table comes from the token, not from a query parameter. BR-05
       says a member acts only on their own table's lines, and a table taken
       from the request is a table the caller can change. */
    req.tableNo = payload.table ?? null;
    if (user.role === 'Member' && !req.tableNo) {
      const t = await get('SELECT table_no FROM packing_tables WHERE member_id = $1', [user.id]);
      req.tableNo = t?.table_no ?? null;
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/** requireRole('Supervisor', 'Administrator') */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(new HttpError(403, `This action needs one of: ${roles.join(', ')}`));
    }
    return next();
  };
}

/**
 * FR-13.3 — the roles allowed to read operational data. Management is
 * deliberately read-only: it reaches the dashboard and the MIS and nothing that
 * writes.
 */
export const canRead = requireRole('Supervisor', 'Administrator', 'Management', 'Member');
export const canSupervise = requireRole('Supervisor', 'Administrator');
export const isAdmin = requireRole('Administrator');
