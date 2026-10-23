import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthReport } from '@cvu/shared';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/claru_test';
const pool = createPool(dbUrl);
let server: Server;
let base = '';

beforeAll(async () => {
  const app = createApp({ pool, logger: createLogger('silent') });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await pool.end();
});

describe('GET /api/healthz', () => {
  it('reports the database as up', async () => {
    const res = await fetch(`${base}/api/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.db.version).toMatch(/^\d+/);
  });

  it('answers unknown API paths with JSON 404', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
