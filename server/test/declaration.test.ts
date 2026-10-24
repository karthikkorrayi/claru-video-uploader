import type { Server } from 'node:http';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { ClaruUnavailableError, claruProjectSource } from '../src/claru/project.js';
import type { UploadSettings } from '../src/uploads/context.js';
import { insertUser } from '../src/users.js';
import { fixture } from './fixtures.js';
import {
  ADMIN_PASSWORD,
  Client,
  createAdmin,
  removeTestDirs,
  resetDatabase,
  runJobs,
  startApp,
  testPool,
  testUploadSettings,
  uploadFile,
} from './helpers.js';

const ALL_TRUE = {
  worker_consent_obtained: true,
  site_or_employer_permission_obtained: true,
  required_consent_or_notice_process_followed: true,
  footage_unedited: true,
};
const SHARED = { categoryCode: 'MOCK-KITCHEN-PREP', country: 'in', siteId: 'hyd-kitchen-2', device: 'GoPro HERO12 Black', mount: 'chest harness' };

let db: pg.Pool;
let settings: UploadSettings;
let server: Server;
let base: string;
let admin: Client;
let asha: Client;
let ravi: Client;
let a1: string;
let a2: string;
let r1: string;

async function consultant(username: string): Promise<Client> {
  await insertUser(db, { username, displayName: username, role: 'consultant', passwordHash: await hashPassword('Consultant-pass-42x'), mustChangePassword: false });
  const c = new Client(base);
  await c.login(username, 'Consultant-pass-42x');
  return c;
}

/** A unique copy of the 12 s fixture: the same bytes twice would be refused as a duplicate upload. */
function uniqueWide(n: number): Buffer {
  const b = Buffer.from(fixture('wide'));
  // Change a digit of the encoder name in the metadata (not picture data: the checks would call that damage).
  const at = b.lastIndexOf('Lavf');
  b.write(String(n % 10), at + 4);
  return b;
}

async function boot(claruProject?: () => Promise<never>) {
  server?.close();
  ({ server, base } = await startApp(db, settings, claruProject));
  for (const c of [admin, asha, ravi]) if (c) Object.assign(c, { base });
}

beforeAll(async () => {
  db = testPool();
  fixture('wide');
}, 120_000);

afterAll(async () => {
  server?.close();
  await db.end();
  removeTestDirs();
});

beforeEach(async () => {
  await resetDatabase(db);
  settings = testUploadSettings();
  await boot();
  await createAdmin(db);
  admin = new Client(base);
  await admin.login('boss', ADMIN_PASSWORD);
  asha = await consultant('asha');
  ravi = await consultant('ravi');
  a1 = await uploadFile(asha, uniqueWide(1), 'a1.mp4');
  a2 = await uploadFile(asha, uniqueWide(2), 'a2.mp4');
  r1 = await uploadFile(ravi, uniqueWide(3), 'r1.mp4');
  await runJobs(db, settings);
}, 60_000);

const item = (id: string, recordedAt = '2026-10-20T09:15:00+05:30', consent = ALL_TRUE) => ({ id, recordedAt, consent });

describe('declaring recordings for Claru', () => {
  it('fills shared fields once for a batch, with capture time and consents per recording', async () => {
    const r = await asha.post('/api/recordings/declaration', {
      shared: SHARED,
      items: [item(a1, '2026-10-20T09:15:00+05:30'), item(a2, '2026-10-20T11:40:00+05:30')],
    });
    expect(r.status).toBe(200);
    expect(r.body.batchRef).toMatch(/^cvu-b-\d{8}-[0-9a-f]{6}$/);
    const [x, y] = r.body.recordings;
    expect(x.declaration).toMatchObject({ ...SHARED, country: 'IN', consent: ALL_TRUE, batchRef: r.body.batchRef, declaredBy: 'asha' });
    expect(x.declaration.recordedAt).toBe('2026-10-20T03:45:00.000Z');
    expect(y.declaration.recordedAt).toBe('2026-10-20T06:10:00.000Z');
    // Checks passed (with the 16:9 warning), one clip each, declared: ready for L4.
    expect(x.readyForDelivery).toBe(true);
  });

  it('refuses unless all four consents are true, and saves nothing', async () => {
    const r = await asha.post('/api/recordings/declaration', {
      shared: SHARED,
      items: [item(a1), item(a2, undefined, { ...ALL_TRUE, footage_unedited: false })],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('consent_incomplete');
    expect((await asha.get(`/api/recordings/${a1}`)).body.recording.declaration).toBeNull();
  });

  it('a consultant cannot declare, or even name, someone else’s recording; the admin can', async () => {
    const r = await asha.post('/api/recordings/declaration', { shared: SHARED, items: [item(a1), item(r1)] });
    expect(r.status).toBe(404);
    expect((await asha.get(`/api/recordings/${a1}`)).body.recording.declaration).toBeNull();
    const byAdmin = await admin.post('/api/recordings/declaration', { shared: SHARED, items: [item(r1)] });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.recordings[0].declaration.declaredBy).toBe('boss');
  });

  it('checks the category against Claru and the capture time against the calendar', async () => {
    const unknown = await asha.post('/api/recordings/declaration', { shared: { ...SHARED, categoryCode: 'K-99' }, items: [item(a1)] });
    expect(unknown.body.error).toBe('unknown_category');
    const future = await asha.post('/api/recordings/declaration', { shared: SHARED, items: [item(a1, '2099-01-01T10:00:00+05:30')] });
    expect(future.status).toBe(400);
    const noZone = await asha.post('/api/recordings/declaration', { shared: SHARED, items: [item(a1, '2026-10-20T09:15:00')] });
    expect(noZone.status).toBe(400);
    const badSite = await asha.post('/api/recordings/declaration', { shared: { ...SHARED, siteId: 'my site!' }, items: [item(a1)] });
    expect(badSite.status).toBe(400);
  });

  it('saves nothing when Claru cannot be reached to confirm the category', async () => {
    await boot(async () => {
      throw new ClaruUnavailableError('Claru could not be reached (TimeoutError).');
    });
    const r = await asha.post('/api/recordings/declaration', { shared: SHARED, items: [item(a1)] });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('claru_unavailable');
    expect((await asha.get('/api/claru/project')).status).toBe(503);
  });

  it('serves the categories for the form', async () => {
    const r = await asha.get('/api/claru/project');
    expect(r.body.project.categories.map((c: { code: string }) => c.code)).toEqual(['MOCK-KITCHEN-PREP', 'MOCK-WAREHOUSE-PICK']);
  });
});

describe('Claru project discovery', () => {
  const ok = { team: { status: 'active' }, projects: [{ id: 'p1', name: 'P', clipLength: { minSeconds: 300, maxSeconds: 1800 }, categories: [{ code: 'K-1', name: 'k', parent: { name: 'K' } }] }] };
  const fake = (status: number, body: unknown) => {
    const calls: Array<{ url: string; key: string | null }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, key: new Headers(init?.headers).get('x-api-key') });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('sends the key only as x-api-key and caches the answer', async () => {
    const { f, calls } = fake(200, ok);
    const src = claruProjectSource({ baseUrl: 'http://claru.test/api/v1', apiKey: 'claru_secretkey123', projectId: 'p1', fetchImpl: f });
    expect((await src.get()).categories).toEqual([{ code: 'K-1', name: 'k', parent: 'K' }]);
    await src.get();
    expect(calls).toEqual([{ url: 'http://claru.test/api/v1/supplier/projects', key: 'claru_secretkey123' }]);
  });

  it('explains a refused key, a blocked team or a missing project without revealing the key', async () => {
    const cases: Array<[number, unknown, RegExp]> = [
      [401, {}, /refused the API key/],
      [200, { team: { blocked: { code: 'TEAM_SUSPENDED', remedy: 'Contact Claru' } } }, /blocked the team: TEAM_SUSPENDED/],
      [200, { projects: [] }, /not in Claru's project list/],
    ];
    for (const [status, body, message] of cases) {
      const src = claruProjectSource({ baseUrl: 'http://claru.test/api/v1', apiKey: 'claru_secretkey123', projectId: 'p1', fetchImpl: fake(status, body).f });
      const err = await src.get().catch((e: Error) => e);
      expect(err).toBeInstanceOf(ClaruUnavailableError);
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toContain('claru_secretkey123');
    }
  });
});
