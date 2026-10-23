// Mock of Claru's supplier API, built only from claru-integration.md (contract v2).
// L0 implements discovery (GET /supplier/projects) and authentication.
// L4 adds create, upload, complete, seal, poll, refusals and fault injection.
import express from 'express';

export interface MockClaruOptions {
  apiKey: string;
}

/** The project from the guide's "Your projects"; category codes are mock samples. */
export const MOCK_PROJECT = {
  id: '92070f8b-acfb-44c2-8e73-1e6d9918a2b6',
  name: 'Commercial Egocentric Evaluation (RGB Supplier Upload)',
  checkGroups: { video: 'error', imu: 'off', stereo: 'off' },
  imuExpected: false,
  captureAspectRatio: '4_3',
  expectedFiles: [
    { fileType: 'video', required: true },
    { fileType: 'inputs', required: false },
    { fileType: 'other', required: false },
  ],
  clipLength: { minSeconds: 300, maxSeconds: 1800 },
  categories: [
    { code: 'MOCK-KITCHEN-PREP', name: 'Food preparation (mock)', parent: { id: 'mock-p1', name: 'Kitchen (mock)' } },
    { code: 'MOCK-WAREHOUSE-PICK', name: 'Picking (mock)', parent: { id: 'mock-p2', name: 'Warehouse (mock)' } },
  ],
  contractVersion: 2,
} as const;

export function createMockClaru(opts: MockClaruOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/__mock/health', (_req, res) => {
    res.json({ ok: true, service: 'mock-claru' });
  });

  // Every API call carries x-api-key; a wrong or missing key is a plain 401 with no code.
  app.use('/api/v1', (req, res, next) => {
    if (req.get('x-api-key') !== opts.apiKey) {
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
      return;
    }
    next();
  });

  app.get('/api/v1/supplier/projects', (_req, res) => {
    res.json({
      team: { id: 'mock-team', name: 'Veda solutions (mock)', status: 'active' },
      contract: { version: 2, minAcceptedVersion: 1 },
      rateLimit: { requestsPerMinute: 600 },
      projects: [MOCK_PROJECT],
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ statusCode: 404, message: 'Not Found (mock: implemented in a later phase)' });
  });

  return app;
}
