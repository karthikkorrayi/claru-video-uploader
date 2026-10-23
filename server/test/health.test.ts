import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthReport } from '@cvu/shared';
import { resetDatabase, startApp, testPool } from './helpers.js';

const db = testPool();
let server: Server;
let base = '';

beforeAll(async () => {
  await resetDatabase(db);
  ({ server, base } = await startApp(db));
});

afterAll(async () => {
  server.close();
  await db.end();
});

describe('GET /api/healthz', () => {
  it('reports the database as up, without signing in', async () => {
    const res = await fetch(`${base}/api/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.db.version).toMatch(/^\d+/);
  });

  it('sends basic security headers', async () => {
    const res = await fetch(`${base}/api/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('hides every other API path behind sign-in', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_signed_in' });
  });
});
