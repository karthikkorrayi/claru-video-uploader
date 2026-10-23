import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { APP_NAME, type HealthReport } from '@cvu/shared';
import { checkDb } from './db.js';

export interface AppDeps {
  pool: pg.Pool;
  logger: Logger;
  startedAt?: number;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const startedAt = deps.startedAt ?? Date.now();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/healthz', async (_req, res) => {
    const db = await checkDb(deps.pool);
    const body: HealthReport = {
      ok: db.ok,
      service: APP_NAME,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      db,
    };
    res.status(db.ok ? 200 : 503).json(body);
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
