import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { CSRF_HEADER, CSRF_VALUE } from '../src/auth/middleware.js';
import { hashPassword } from '../src/auth/password.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { migrate } from '../src/migrate.js';
import { insertUser } from '../src/users.js';

export const TEST_SECRET = 't'.repeat(48);
export const ADMIN_PASSWORD = 'Admin-password-123';

const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/claru_test';

/** Refuses to touch anything but a database whose name ends in _test. */
export function testPool(): pg.Pool {
  const name = new URL(dbUrl).pathname.slice(1);
  if (!name.endsWith('_test')) throw new Error(`Tests only run against a *_test database, not "${name}"`);
  return createPool(dbUrl);
}

/** Drops and recreates the test schema, then applies all migrations. */
export async function resetDatabase(db: pg.Pool): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

export async function startApp(db: pg.Pool): Promise<{ server: Server; base: string }> {
  const app = createApp({
    pool: db,
    logger: createLogger('silent'),
    sessionSecret: TEST_SECRET,
    sessionHours: 12,
    cookieSecure: false,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function createAdmin(db: pg.Pool, username = 'boss'): Promise<string> {
  const u = await insertUser(db, {
    username,
    displayName: 'The Admin',
    role: 'admin',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    mustChangePassword: false,
  });
  return u.id;
}

/** A tiny browser: keeps the session cookie and always sends the CSRF header. */
export class Client {
  cookie = '';
  constructor(private readonly base: string) {}

  async request(method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.csrf !== false) headers[CSRF_HEADER] = CSRF_VALUE;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0] ?? '';
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked field by field
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, any>, setCookie };
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown, opts?: { csrf?: boolean }) {
    return this.request('POST', path, body ?? {}, opts);
  }
  async login(username: string, password: string) {
    return this.post('/api/auth/login', { username, password });
  }
}
