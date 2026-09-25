import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/* Minimal .env loader — keeps the dependency list free of dotenv. */
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4100),

  // The SPD application owns its own PostgreSQL database — it is not a schema
  // inside PFEP/TMS/WMS. Keeping it separate is what lets the shift-locking and
  // exception rules below be enforced without coordinating with another
  // product's migrations.
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/vistar_spd',
  pgSsl: String(process.env.PGSSL || '').toLowerCase() === 'true',
  pgPoolMax: Number(process.env.PG_POOL_MAX || 10),

  jwtSecret: process.env.JWT_SECRET || 'spd-dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  storageDir: abs(process.env.STORAGE_DIR || './storage'),
  get uploadDir() { return path.join(this.storageDir, 'uploads'); },
  // NFR-1.2: a day-wise GRN file runs to ~5,000 line items. 16 MB covers that
  // with room for an .xlsx that carries formatting.
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 16) * 1024 * 1024,

  corsOrigin: process.env.CORS_ORIGIN || '*',

  /* ---- FR-8: automated hourly report ---------------------------------- */
  // The scheduler is off by default. It sends mail, and a developer running the
  // API on a laptop should not start posting shift reports to the real
  // distribution list simply by starting the server.
  hourlyEnabled: String(process.env.HOURLY_ENABLED || 'false').toLowerCase() === 'true',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'spd-app@vistarlogitek.com',
  },
};

fs.mkdirSync(config.uploadDir, { recursive: true });
