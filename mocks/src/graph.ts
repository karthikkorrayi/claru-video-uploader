// Mock of the Microsoft Graph calls used for OneDrive backups.
// L0: health only. L5 adds upload sessions, chunk rules, resume, conflict handling.
import express from 'express';

export function createMockGraph(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/__mock/health', (_req, res) => {
    res.json({ ok: true, service: 'mock-graph' });
  });

  app.use((_req, res) => {
    res.status(501).json({ error: { code: 'notImplemented', message: 'mock Graph: implemented in phase L5' } });
  });

  return app;
}
