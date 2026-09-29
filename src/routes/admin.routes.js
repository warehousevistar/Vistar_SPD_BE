import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { all, get, tx } from '../db/index.js';
import { requireAuth, canRead, canSupervise, isAdmin } from '../middleware/auth.js';
import { wrap, badRequest, conflict, notFound } from '../middleware/error.js';
import { settings, saveSettings, DEFAULTS } from '../lib/settings.js';
import { audit, auditRows } from '../lib/audit.js';

export const adminRoutes = Router();
adminRoutes.use(requireAuth);

/** What each role may reach — shown on the Users screen (FR-13.3). */
const ACCESS = {
  Supervisor: 'GRN upload · labels · allocation · review · final submission · MIS & dashboard',
  Member: "Own table's lines only · Start / Submit packing (BR-05)",
  Administrator: 'Users, roles, tables, label template, email list, thresholds',
  Management: 'Read-only dashboard and MIS export',
};

/* ------------------------------------------------------ FR-13.1 users ----- */

adminRoutes.get('/users', canRead, wrap(async (_req, res) => {
  const users = await all(
    `SELECT u.id, u.name, u.emp_code, u.role, u.email, u.device, u.active, u.last_login_at,
            pt.table_no
       FROM users u
       LEFT JOIN packing_tables pt ON pt.member_id = u.id
      ORDER BY CASE u.role WHEN 'Supervisor' THEN 0 WHEN 'Administrator' THEN 1 WHEN 'Management' THEN 2 ELSE 3 END, u.name`,
  );
  res.json({ users: users.map((u) => ({ ...u, access: ACCESS[u.role] ?? '' })) });
}));

adminRoutes.post('/users', isAdmin, wrap(async (req, res) => {
  const { id, name, empCode, role, email = '', device = '', password, pin } = req.body ?? {};
  if (!id || !name || !empCode || !role) throw badRequest('A user needs a login ID, name, employee code and role');
  if (!Object.keys(ACCESS).includes(role)) throw badRequest(`Role must be one of: ${Object.keys(ACCESS).join(', ')}`);
  if (role !== 'Member' && !password) throw badRequest('A Supervisor, Administrator or Management account needs a password');
  if (role === 'Member' && !pin && !password) throw badRequest('A Table Member needs a PIN (or a password)');

  if (await get('SELECT id FROM users WHERE id = $1', [id])) throw conflict(`Login ID ${id} is already in use`);
  if (await get('SELECT id FROM users WHERE emp_code = $1', [empCode])) throw conflict(`Employee code ${empCode} is already in use`);

  await tx(async (q) => {
    await q(
      `INSERT INTO users (id, name, emp_code, role, email, device, password_hash, pin_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, name, empCode, role, email, device,
        password ? await bcrypt.hash(String(password), 10) : null,
        pin ? await bcrypt.hash(String(pin), 10) : null],
    );
    await audit({
      actorId: req.user.id, action: 'User Created', reference: id,
      detail: `${name} · ${empCode} · ${role}`, before: '—', after: 'Active',
    }, q);
  });
  res.status(201).json({ ok: true });
}));

adminRoutes.patch('/users/:id', isAdmin, wrap(async (req, res) => {
  const u = await get('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!u) throw notFound('No such user');
  const { name, role, email, device, active, password, pin } = req.body ?? {};

  if (role && !Object.keys(ACCESS).includes(role)) throw badRequest(`Role must be one of: ${Object.keys(ACCESS).join(', ')}`);
  /* A deactivated Supervisor with nobody else able to finalise a shift would
     strand the floor, so the last active one cannot be switched off. */
  if (active === false && u.role === 'Supervisor') {
    const others = await get(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'Supervisor' AND active AND id <> $1`, [u.id]);
    if (others.n === 0) throw conflict('This is the last active Supervisor — appoint another before deactivating this account');
  }

  await tx(async (q) => {
    await q(
      `UPDATE users SET name = $2, role = $3, email = $4, device = $5, active = $6,
              password_hash = COALESCE($7, password_hash), pin_hash = COALESCE($8, pin_hash)
        WHERE id = $1`,
      [u.id, name ?? u.name, role ?? u.role, email ?? u.email, device ?? u.device,
        active === undefined ? u.active : Boolean(active),
        password ? await bcrypt.hash(String(password), 10) : null,
        pin ? await bcrypt.hash(String(pin), 10) : null],
    );
    await audit({
      actorId: req.user.id, action: 'User Updated', reference: u.id,
      detail: [name && `name → ${name}`, role && `role → ${role}`,
        active !== undefined && `${active ? 'activated' : 'deactivated'}`,
        password && 'password reset', pin && 'PIN reset'].filter(Boolean).join(' · ') || 'no change',
      before: `${u.role} · ${u.active ? 'active' : 'inactive'}`, after: 'Saved',
    }, q);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------- FR-13.2 masters & config ----- */

adminRoutes.get('/config', canRead, wrap(async (_req, res) => {
  res.json({ config: await settings(), defaults: DEFAULTS });
}));

adminRoutes.put('/config', canSupervise, wrap(async (req, res) => {
  const patch = req.body ?? {};
  const before = await settings();

  // NFR-4.2 — say exactly which value is out of range, not "invalid input".
  if (patch.threshold !== undefined) {
    const t = Number(patch.threshold);
    if (!(t > 0 && t <= 100)) throw badRequest('The abnormal-entry threshold is a percentage between 1 and 100');
    patch.threshold = t;
  }
  if (patch.hourly !== undefined) {
    const h = Number(patch.hourly);
    if (!(h >= 5 && h <= 720)) throw badRequest('The hourly report interval must be between 5 and 720 minutes');
    patch.hourly = h;
  }
  if (patch.refresh !== undefined) {
    const r = Number(patch.refresh);
    if (!(r >= 10 && r <= 3600)) throw badRequest('The dashboard refresh interval must be between 10 and 3600 seconds');
    patch.refresh = r;
  }
  if (patch.emails !== undefined) {
    const list = Array.isArray(patch.emails)
      ? patch.emails
      : String(patch.emails).split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad.length) throw badRequest(`Not a valid email address: ${bad.join(', ')}`);
    if (!list.length) throw badRequest('The hourly report needs at least one recipient (FR-8.2)');
    patch.emails = list;
  }
  if (patch.grnCols !== undefined) {
    const cols = Array.isArray(patch.grnCols) ? patch.grnCols : String(patch.grnCols).split(',').map((s) => s.trim()).filter(Boolean);
    if (cols.length < 3) throw badRequest('The GRN import needs at least Invoice No., Part Number and GRN Quantity');
    patch.grnCols = cols;
  }

  const after = await saveSettings(patch, req.user.id);
  await audit({
    actorId: req.user.id, action: 'Config Change', reference: 'System parameters',
    detail: `Threshold ${after.threshold}% · hourly ${after.hourly} min · refresh ${after.refresh}s · ${after.emails.length} recipients · ${after.labelTpl}`,
    before: `Threshold ${before.threshold}% · hourly ${before.hourly} min · refresh ${before.refresh}s`,
    after: 'Saved',
  });
  res.json({ config: after });
}));

/* ------------------------------------------------- NFR-3.3 audit trail ---- */

adminRoutes.get('/audit', canRead, wrap(async (req, res) => {
  const rows = await auditRows({
    action: req.query.action ?? '',
    q: req.query.q ?? '',
    limit: Math.min(1000, Number(req.query.limit) || 300),
  });
  const actions = (await all('SELECT DISTINCT action FROM audit_log ORDER BY action')).map((r) => r.action);
  res.json({ entries: rows, actions });
}));
