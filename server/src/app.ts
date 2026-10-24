import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { APP_NAME, type HealthReport } from '@cvu/shared';
import { csrfGuard, loadSession, requireAdmin, requireAuth, requirePasswordChanged } from './auth/middleware.js';
import { checkDb } from './db.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { claruRoutes } from './routes/claru.js';
import { recordingRoutes } from './routes/recordings.js';
import type { ClaruProjectView } from '@cvu/shared';
import type { UploadSettings } from './uploads/context.js';
import { createUploadHandler } from './uploads/tus.js';

export interface AppDeps {
  pool: pg.Pool;
  logger: Logger;
  sessionSecret: string;
  sessionHours: number;
  cookieSecure: boolean;
  /** 'loopback' behind Caddy on the same server (production); 'no' locally. */
  trustProxy?: 'no' | 'loopback';
  startedAt?: number;
  uploads: UploadSettings;
  /** Claru's project, cached (see claru/project.ts). */
  claruProject: () => Promise<ClaruProjectView>;
}

export function createApp(deps: AppDeps): express.Express {
  const { pool: db } = deps;
  const app = express();
  const startedAt = deps.startedAt ?? Date.now();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy === 'loopback' ? 'loopback' : false);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // Public: health only.
  app.get('/api/healthz', async (_req, res) => {
    const dbHealth = await checkDb(db);
    const body: HealthReport = {
      ok: dbHealth.ok,
      service: APP_NAME,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      db: dbHealth,
    };
    res.status(dbHealth.ok ? 200 : 503).json(body);
  });

  app.use('/api', csrfGuard(), loadSession(db, deps.sessionSecret));

  // Sign-in, sign-out, who am I, change password: allowed even with a temporary password.
  app.use(
    '/api/auth',
    authRoutes({ db, sessionSecret: deps.sessionSecret, sessionHours: deps.sessionHours, cookieSecure: deps.cookieSecure }),
  );

  // Everything below needs a signed-in user who has replaced any temporary password.
  app.use('/api', requireAuth, requirePasswordChanged);
  app.use('/api/admin', requireAdmin, adminRoutes(db));

  // Uploads (L2): declare a recording, then send its bytes with tus.
  const uploadCtx = { db, logger: deps.logger, settings: deps.uploads, claruProject: deps.claruProject };
  app.use('/api/recordings', recordingRoutes(uploadCtx));
  app.use('/api/claru', claruRoutes(uploadCtx));
  app.use(createUploadHandler(uploadCtx)); // handles /api/uploads itself (tus needs the unmodified URL)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
