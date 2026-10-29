import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { APP_NAME, type HealthReport } from '@cvu/shared';
import { csrfGuard, loadSession, requireAdmin, requireAuth, requirePasswordChanged } from './auth/middleware.js';
import { checkDb } from './db.js';
import { recordProblem } from './problems.js';
import { requestLog } from './requestLog.js';
import type { ClaruClient } from './claru/client.js';
import type { ReviewSettings } from './review.js';
import { claruAdminRoutes } from './routes/claruAdmin.js';
import { clientErrorRoutes } from './routes/clientErrors.js';
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
  /** Banner text for the web app (ENVIRONMENT_LABEL). */
  environment?: string;
  /** Phase L4: delivery to Claru and its review. */
  delivery?: {
    claru: ClaruClient;
    review: ReviewSettings;
    /** The mock's origin when CLARU_BASE_URL points at it; null for the real Claru. */
    mockOrigin: string | null;
    pollNow: () => Promise<void>;
  };
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
  app.use(requestLog(deps.logger));
  app.use(express.json({ limit: '100kb' }));

  // Public: health only.
  app.get('/api/healthz', async (_req, res) => {
    const dbHealth = await checkDb(db);
    const body: HealthReport = {
      ok: dbHealth.ok,
      service: APP_NAME,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      db: dbHealth,
      environment: deps.environment ?? '',
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
  if (deps.delivery) {
    app.use(
      '/api/admin/claru',
      requireAdmin,
      claruAdminRoutes({ db, review: deps.delivery.review, mockOrigin: deps.delivery.mockOrigin, pollNow: deps.delivery.pollNow }),
    );
  }
  app.use('/api/admin', requireAdmin, adminRoutes(db));

  // Uploads (L2): declare a recording, then send its bytes with tus.
  const uploadCtx = { db, logger: deps.logger, settings: deps.uploads, claruProject: deps.claruProject };
  app.use('/api/recordings', recordingRoutes(uploadCtx));
  app.use('/api/claru', claruRoutes(uploadCtx));
  app.use('/api/client-errors', clientErrorRoutes(db, deps.logger));
  app.use(createUploadHandler(uploadCtx)); // handles /api/uploads itself (tus needs the unmodified URL)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ err, reqId: req.id, method: req.method, path: req.path }, 'unhandled error');
    void recordProblem(db, deps.logger, {
      source: 'server',
      message: (err as Error)?.message ?? String(err),
      detail: { method: req.method, path: req.path, stack: (err as Error)?.stack?.split('\n').slice(0, 8).join('\n') },
      userId: req.auth?.user.id,
      requestId: req.id,
    });
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', requestId: req.id });
  });

  return app;
}
