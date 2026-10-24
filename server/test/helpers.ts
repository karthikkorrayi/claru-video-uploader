import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { CSRF_HEADER, CSRF_VALUE } from '../src/auth/middleware.js';
import { hashPassword } from '../src/auth/password.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { migrate } from '../src/migrate.js';
import { fingerprintFromSamples, fingerprintRanges, type ClaruProjectView } from '@cvu/shared';
import { createJobRunner } from '../src/jobs.js';
import { jobHandlers, onJobGiveUp } from '../src/processing.js';
import type { UploadSettings } from '../src/uploads/context.js';
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

const testDirs: string[] = [];

/** Fresh, empty upload folders. Call removeTestDirs() in afterAll. */
export function testUploadSettings(overrides: Partial<UploadSettings> = {}): UploadSettings {
  const root = mkdtempSync(join(tmpdir(), 'cvu-test-'));
  testDirs.push(root);
  mkdirSync(join(root, 'tus'));
  mkdirSync(join(root, 'work'));
  return {
    tusDir: join(root, 'tus'),
    workDir: join(root, 'work'),
    maxUploadBytes: 64 * 1024 * 1024,
    diskReserveBytes: 0,
    abandonAfterHours: 72,
    tools: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    // Short clips so the test videos stay small; the real values are 300–1800 s.
    clipRules: { minSeconds: 10, maxSeconds: 30, aspect: '4_3' },
    ...overrides,
  };
}

export function removeTestDirs(): void {
  for (const d of testDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Tests that do not upload share one fixed folder instead of creating a new one each run. */
function idleUploadSettings(): UploadSettings {
  const root = join(tmpdir(), 'cvu-test-idle');
  mkdirSync(join(root, 'tus'), { recursive: true });
  mkdirSync(join(root, 'work'), { recursive: true });
  return {
    tusDir: join(root, 'tus'),
    workDir: join(root, 'work'),
    maxUploadBytes: 1024,
    diskReserveBytes: 0,
    abandonAfterHours: 72,
    tools: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    clipRules: { minSeconds: 300, maxSeconds: 1800, aspect: '4_3' },
  };
}

/** A stand-in for Claru's project discovery (the real call is tested against the mock in claru.test.ts). */
export const TEST_PROJECT: ClaruProjectView = {
  id: '92070f8b-acfb-44c2-8e73-1e6d9918a2b6',
  name: 'Test project',
  captureAspectRatio: '4_3',
  clipLength: { minSeconds: 300, maxSeconds: 1800 },
  categories: [
    { code: 'MOCK-KITCHEN-PREP', name: 'Food preparation', parent: 'Kitchen' },
    { code: 'MOCK-WAREHOUSE-PICK', name: 'Picking', parent: 'Warehouse' },
  ],
};

export async function startApp(
  db: pg.Pool,
  uploads: UploadSettings = idleUploadSettings(),
  claruProject: () => Promise<ClaruProjectView> = async () => TEST_PROJECT,
): Promise<{ server: Server; base: string }> {
  const app = createApp({
    pool: db,
    logger: createLogger('silent'),
    sessionSecret: TEST_SECRET,
    sessionHours: 12,
    cookieSecure: false,
    uploads,
    claruProject,
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

  /** A raw tus request (resumable upload protocol), with this client's cookie and the CSRF header. */
  tus(method: 'POST' | 'HEAD' | 'PATCH' | 'DELETE', path: string, headers: Record<string, string> = {}, body?: Uint8Array) {
    return fetch(this.base + path, {
      method,
      headers: {
        'tus-resumable': '1.0.0',
        [CSRF_HEADER]: CSRF_VALUE,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body ? { 'content-type': 'application/offset+octet-stream' } : {}),
        ...headers,
      },
      body,
    });
  }
  post(path: string, body?: unknown, opts?: { csrf?: boolean }) {
    return this.request('POST', path, body ?? {}, opts);
  }
  async login(username: string, password: string) {
    return this.post('/api/auth/login', { username, password });
  }
}

/** Runs every queued background job (checks, cutting) now, as the server's worker would. */
export async function runJobs(db: pg.Pool, settings: UploadSettings): Promise<number> {
  const core = { db, logger: createLogger('silent'), settings };
  return createJobRunner({ db, logger: core.logger, handlers: jobHandlers(core), onGiveUp: onJobGiveUp(core) }).drain();
}

/** Declares and uploads a whole file the way the browser does (tus, 4 MiB pieces). Returns the recording id. */
export async function uploadFile(c: Client, file: Buffer, filename: string): Promise<string> {
  const { head, tail } = fingerprintRanges(file.length);
  const fingerprint = await fingerprintFromSamples(file.length, file.subarray(...head), file.subarray(...tail));
  const d = await c.post('/api/recordings', { filename, sizeBytes: file.length, fingerprint });
  if (d.status !== 201 && d.status !== 200) throw new Error(`declare failed: ${d.status} ${JSON.stringify(d.body)}`);
  const id = d.body.recording.id as string;
  const meta = `recordingId ${Buffer.from(id).toString('base64')}`;
  const created = await c.tus('POST', '/api/uploads', { 'upload-length': String(file.length), 'upload-metadata': meta });
  if (created.status !== 201) throw new Error(`tus create failed: ${created.status}`);
  const piece = 4 * 1024 * 1024;
  for (let off = 0; off < file.length; off += piece) {
    const r = await c.tus('PATCH', `/api/uploads/${id}`, { 'upload-offset': String(off) }, file.subarray(off, Math.min(off + piece, file.length)));
    if (r.status !== 204) throw new Error(`tus patch failed: ${r.status} ${await r.text()}`);
  }
  return id;
}
