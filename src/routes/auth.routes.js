import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { all, get, run } from '../db/index.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { wrap, badRequest, HttpError } from '../middleware/error.js';
import { audit } from '../lib/audit.js';

export const authRoutes = Router();

/**
 * The login screen needs the member roster before anyone has authenticated —
 * FR-5.1 lets a Table Member sign in by picking their name from a master list
 * rather than typing an ID. Only what the picker draws is exposed: name,
 * employee code and table. No email, no device, no password state.
 */
authRoutes.get('/members', wrap(async (_req, res) => {
  const rows = await all(
    `SELECT u.id, u.name, u.emp_code, pt.table_no
       FROM users u
       LEFT JOIN packing_tables pt ON pt.member_id = u.id
      WHERE u.role = 'Member' AND u.active
      ORDER BY pt.sort_order NULLS LAST, u.name`,
  );
  res.json({ members: rows });
}));

/**
 * NFR-3.1 — one endpoint, two credential shapes. A Supervisor, Administrator
 * or Management user signs in with a password; a Table Member may sign in with
 * a PIN, which is what makes the shop-floor login a two-tap affair.
 */
authRoutes.post('/login', wrap(async (req, res) => {
  const { userId, password, pin } = req.body ?? {};
  if (!userId) throw badRequest('Enter your user ID, or select your name from the list');

  const user = await get('SELECT * FROM users WHERE id = $1', [String(userId).trim()]);
  // Same message either way: which half was wrong is not the caller's business.
  const reject = () => { throw new HttpError(401, 'That user ID and password do not match'); };
  if (!user) reject();
  if (!user.active) throw new HttpError(403, 'That account has been deactivated — contact the Administrator');

  const secret = user.role === 'Member' && pin ? pin : password;
  if (!secret) {
    throw badRequest(user.role === 'Member'
      ? 'Enter your PIN to continue'
      : 'Enter your password to continue');
  }
  const hash = user.role === 'Member' && pin ? user.pin_hash : user.password_hash;
  if (!hash || !(await bcrypt.compare(String(secret), hash))) reject();

  const table = await get('SELECT table_no FROM packing_tables WHERE member_id = $1', [user.id]);
  const tableNo = table?.table_no ?? null;

  await run('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit({
    actorId: user.id, action: 'Sign In', reference: user.id,
    detail: `${user.role}${tableNo ? ` · ${tableNo}` : ''} · ${user.device || 'web'}`,
    before: '—', after: 'Session opened',
  });

  delete user.password_hash;
  delete user.pin_hash;
  res.json({ token: signToken(user, tableNo), user: { ...user, table_no: tableNo } });
}));

authRoutes.get('/me', requireAuth, wrap(async (req, res) => {
  res.json({ user: { ...req.user, table_no: req.tableNo } });
}));

authRoutes.post('/logout', requireAuth, wrap(async (req, res) => {
  await audit({ actorId: req.user.id, action: 'Sign Out', reference: req.user.id, before: 'Session open', after: 'Session closed' });
  res.json({ ok: true });
}));
