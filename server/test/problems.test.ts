import type { Server } from 'node:http';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { insertUser } from '../src/users.js';
import { ADMIN_PASSWORD, Client, createAdmin, removeTestDirs, resetDatabase, startApp, testPool, testUploadSettings } from './helpers.js';

let db: pg.Pool;
let server: Server;
let base: string;
let admin: Client;
let asha: Client;

beforeAll(() => {
  db = testPool();
});
afterAll(async () => {
  server?.close();
  await db.end();
  removeTestDirs();
});

beforeEach(async () => {
  server?.close();
  await resetDatabase(db);
  // A Claru source that fails in an unexpected way, to produce a real server error.
  ({ server, base } = await startApp(db, testUploadSettings(), async () => {
    throw new Error('boom: unexpected');
  }));
  await createAdmin(db);
  admin = new Client(base);
  await admin.login('boss', ADMIN_PASSWORD);
  await insertUser(db, { username: 'asha', displayName: 'Asha', role: 'consultant', passwordHash: await hashPassword('Consultant-pass-42x'), mustChangePassword: false });
  asha = new Client(base);
  await asha.login('asha', 'Consultant-pass-42x');
});

describe('problems the admin can see without logging in to the server', () => {
  it('a server error gets a reference the tester can quote, and is recorded', async () => {
    const res = await fetch(`${base}/api/claru/project`, { headers: { cookie: asha.cookie } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    await new Promise((r) => setTimeout(r, 50)); // recorded just after the response
    const list = await admin.get('/api/admin/problems');
    expect(list.body.problems[0]).toMatchObject({ source: 'server', message: 'boom: unexpected', user: 'asha', requestId: body.requestId });
  });

  it('records errors reported by a tester’s browser, at most 20 a minute', async () => {
    const r = await asha.post('/api/client-errors', { message: 'TypeError: x is undefined', kind: 'error', page: '/upload', stack: 'at f (app.js:1)' });
    expect(r.status).toBe(204);
    const list = await admin.get('/api/admin/problems');
    expect(list.body.problems[0]).toMatchObject({ source: 'browser', message: 'TypeError: x is undefined', user: 'asha', page: '/upload' });
    expect(list.body.problems[0].detail.stack).toBe('at f (app.js:1)');
    for (let i = 0; i < 19; i++) await asha.post('/api/client-errors', { message: `e${i}` });
    expect((await asha.post('/api/client-errors', { message: 'one too many' })).status).toBe(429);
    expect((await asha.post('/api/client-errors', {})).status).toBe(429);
  });

  it('only the admin can read problems; reporting needs a sign-in', async () => {
    expect((await asha.get('/api/admin/problems')).status).toBe(403);
    expect((await new Client(base).post('/api/client-errors', { message: 'x' })).status).toBe(401);
  });

  it('says which environment this is', async () => {
    const h = (await (await fetch(`${base}/api/healthz`)).json()) as { environment: string };
    expect(h.environment).toBe('');
  });
});

describe('request log', () => {
  it('logs the full path and never the query string', async () => {
    const lines: string[] = [];
    const { requestLog } = await import('../src/requestLog.js');
    const express = (await import('express')).default;
    const sink = { write: (s: string) => lines.push(s) };
    const { pino } = await import('pino');
    const app = express();
    app.use(requestLog(pino({ level: 'info' }, sink)));
    const r = express.Router();
    r.get('/thing', (_q, s) => void s.json({ ok: true }));
    app.use('/api/sub', r);
    const srv = app.listen(0);
    await new Promise((ok) => srv.once('listening', ok));
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sub/thing?token=secret`);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{12}$/);
    await new Promise((ok) => setTimeout(ok, 20));
    srv.close();
    const entry = JSON.parse(lines[0]!) as { path: string; status: number };
    expect(entry).toMatchObject({ path: '/api/sub/thing', status: 200 });
    expect(lines.join('')).not.toContain('secret');
  });
});
