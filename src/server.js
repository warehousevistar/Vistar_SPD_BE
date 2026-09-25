import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { migrate, healthCounts, pool } from './db/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { startHourlyScheduler } from './services/hourly.js';

import { authRoutes } from './routes/auth.routes.js';
import { grnRoutes } from './routes/grn.routes.js';
import { lineRoutes } from './routes/lines.routes.js';
import { allocRoutes } from './routes/alloc.routes.js';
import { packingRoutes } from './routes/packing.routes.js';
import { reviewRoutes } from './routes/review.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { reportRoutes } from './routes/reports.routes.js';
import { adminRoutes } from './routes/admin.routes.js';

export const app = express();

app.set('trust proxy', 1);
app.use(cors({
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
  credentials: true,
  maxAge: 86400,
}));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/api/health', async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      service: 'vistar-spd-backend',
      env: config.env,
      uptimeSec: Math.round(process.uptime()),
      counts: await healthCounts(),
    });
  } catch (err) { next(err); }
});

/* The dashboard and the member queue are polled every few seconds. Without
   this a browser caches those JSON responses heuristically, and a supervisor
   watching the floor sees a figure that stopped moving while the tables kept
   submitting — which is the exact failure the real-time requirement exists to
   remove (FR-7.3, FR-11.4). */
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api', grnRoutes);
app.use('/api', lineRoutes);
app.use('/api', allocRoutes);
app.use('/api', packingRoutes);
app.use('/api', reviewRoutes);
app.use('/api', dashboardRoutes);
app.use('/api', reportRoutes);
app.use('/api', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

/** Applies the schema, starts the scheduler and listens. */
export async function start() {
  await migrate();
  const stopScheduler = startHourlyScheduler();
  const server = app.listen(config.port, () => {
    console.log(`[spd] Vistar SPD API listening on http://localhost:${config.port}/api (${config.env})`);
  });

  const shutdown = async (signal) => {
    console.log(`[spd] ${signal} — shutting down`);
    stopScheduler();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    // A request that will not finish must not hold the shift's data open.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Only listen when run directly, so tests can import `app` without a port.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error('[spd] failed to start:', err);
    process.exit(1);
  });
}
