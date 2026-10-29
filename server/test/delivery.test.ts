import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockClaru, type MockClaruHandle } from '../../mocks/src/claru.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { recordClaruCalls } from '../src/claru/calls.js';
import { createClaruClient, type ClaruClient } from '../src/claru/client.js';
import { claruProjectSource } from '../src/claru/project.js';
import { createJobRunner } from '../src/jobs.js';
import { createLogger } from '../src/logger.js';
import { jobHandlers, onJobGiveUp } from '../src/processing.js';
import { pollReviews, runReviewAlerts } from '../src/review.js';
import type { UploadSettings } from '../src/uploads/context.js';
import { insertUser } from '../src/users.js';
import { fixture } from './fixtures.js';
import { ADMIN_PASSWORD, Client, createAdmin, removeTestDirs, resetDatabase, TEST_SECRET, testPool, testUploadSettings, uploadFile } from './helpers.js';

const KEY = 'claru_testkey_never_logged_12345';
const MiB = 1024 * 1024;
const PROJECT = '92070f8b-acfb-44c2-8e73-1e6d9918a2b6';
const logger = createLogger('silent');
const review = { alertAfterHours: 72, remindEveryHours: 6 };
const ALL_TRUE = {
  worker_consent_obtained: true,
  site_or_employer_permission_obtained: true,
  required_consent_or_notice_process_followed: true,
  footage_unedited: true,
};
const SHARED = { categoryCode: 'MOCK-KITCHEN-PREP', country: 'IN', siteId: 'hyd-kitchen-2', device: 'GoPro HERO12 Black', mount: 'chest harness' };

let db: pg.Pool;
let settings: UploadSettings;
let mock: MockClaruHandle;
let mockServer: Server;
let mockOrigin: string;
let app: Server;
let base: string;
let claru: ClaruClient;
let sleeps: number[];
let admin: Client;
let asha: Client;
let ravi: Client;

function client(projectId = PROJECT): ClaruClient {
  return createClaruClient({
    baseUrl: `${mockOrigin}/api/v1`,
    apiKey: KEY,
    projectId,
    contractVersion: 2,
    onCall: recordClaruCalls(db, logger),
    // Record waits instead of waiting, so "obeys Retry-After" is checked without slowing the tests.
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

async function runJobs(c: ClaruClient = claru): Promise<void> {
  const core = { db, logger, settings, claru: c };
  await createJobRunner({ db, logger, handlers: jobHandlers(core), onGiveUp: onJobGiveUp(core) }).drain();
}

async function consultant(username: string): Promise<Client> {
  await insertUser(db, { username, displayName: username, role: 'consultant', passwordHash: await hashPassword('Consultant-pass-42x'), mustChangePassword: false });
  const c = new Client(base);
  await c.login(username, 'Consultant-pass-42x');
  return c;
}

/** A unique copy of a fixture (a different encoder digit in the metadata): Claru refuses exact duplicates. */
function unique(name: 'good' | 'wide', n: number): Buffer {
  const b = Buffer.from(fixture(name));
  b.write(String(n % 10), b.lastIndexOf('Lavf') + 4);
  return b;
}

const faults = (f: Record<string, unknown>) =>
  fetch(`${mockOrigin}/__mock/faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) });

/** Upload, check and cut, declare, then deliver. Faults are set just before delivery (the form itself asks Claru for categories). */
async function uploadAndDeclare(c: Client, name: 'good' | 'wide', n: number, recordedAt = '2026-10-20T09:00:00+05:30', fault?: Record<string, unknown>): Promise<string> {
  const id = await uploadFile(c, unique(name, n), `${name}-${n}.mp4`);
  await runJobs(); // checks + cutting
  const d = await c.post('/api/recordings/declaration', { shared: SHARED, items: [{ id, recordedAt, consent: ALL_TRUE }] });
  expect(d.status).toBe(200);
  if (fault) await faults(fault);
  await runJobs(); // delivery
  return id;
}

const recording = async (c: Client, id: string) => (await c.get(`/api/recordings/${id}`)).body.recording;
const mockSubs = () => mock.submissions();

beforeAll(async () => {
  db = testPool();
  fixture('good');
  fixture('wide');
}, 120_000);

afterAll(async () => {
  app?.close();
  mockServer?.close();
  await db.end();
  removeTestDirs();
});

beforeEach(async () => {
  app?.close();
  mockServer?.close();
  await resetDatabase(db);
  sleeps = [];
  // Small slices so the test files use both upload shapes: ≤ 3 MiB "put", larger "multipart" in 1 MiB parts.
  mock = createMockClaru({ apiKey: KEY, partSizeBytes: MiB, putThresholdBytes: 3 * MiB, processingSeconds: 0, retryAfterSeconds: 1, clipLength: { minSeconds: 10, maxSeconds: 30 } });
  mockServer = mock.listen(0, '127.0.0.1');
  await new Promise<void>((r) => mockServer.once('listening', () => r()));
  mockOrigin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
  claru = client();
  settings = testUploadSettings();
  const project = claruProjectSource({ baseUrl: `${mockOrigin}/api/v1`, apiKey: KEY, projectId: PROJECT });
  app = createApp({
    pool: db,
    logger,
    sessionSecret: TEST_SECRET,
    sessionHours: 12,
    cookieSecure: false,
    uploads: settings,
    claruProject: project.get,
    delivery: { claru, review, mockOrigin, pollNow: async () => void (await pollReviews({ db, logger, claru, review })) },
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => app.once('listening', () => r()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await createAdmin(db);
  admin = new Client(base);
  await admin.login('boss', ADMIN_PASSWORD);
  asha = await consultant('asha');
  ravi = await consultant('ravi');
});

describe('delivery to Claru (steps 2–5 of the guide)', () => {
  it('sends every clip with the declaration Claru expects, by both upload shapes, and seals it', async () => {
    const good = await uploadAndDeclare(asha, 'good', 1, '2026-10-20T09:00:00+05:30');
    const wide = await uploadAndDeclare(asha, 'wide', 2);

    const r = await recording(asha, good);
    expect(r.clips.map((c: { submission: { state: string } }) => c.submission.state)).toEqual(['processing', 'processing', 'processing']);
    const w = await recording(asha, wide);
    expect(w.clips[0].submission.state).toBe('processing');

    const subs = mockSubs();
    expect(subs).toHaveLength(4);
    const first = subs.find((s) => s.externalRef === `cvu-${good}-c01`)!;
    const second = subs.find((s) => s.externalRef === `cvu-${good}-c02`)!;
    expect(first.declared).toMatchObject({
      ...SHARED,
      collectorId: 'asha',
      recordedAt: '2026-10-20T03:30:00.000Z',
      consent: ALL_TRUE,
    });
    // Each clip's recordedAt is the recording start plus where the clip begins in it.
    const offset = (Date.parse(second.declared.recordedAt as string) - Date.parse(first.declared.recordedAt as string)) / 1000;
    expect(offset).toBeCloseTo(r.clips[1].startSeconds, 1);
    expect(second.declared.durationSeconds).toBeCloseTo(r.clips[1].durationSeconds, 2);
    // Upload shapes: the 2.3 MB file went as one "put", the 3.6 MB clips as 1 MiB multipart slices.
    expect(subs.find((s) => s.externalRef === `cvu-${wide}-c01`)!.parts[0]!.kind).toBe('put');
    expect(first.parts[0]!.kind).toBe('multipart');
    expect(first.parts[0]!.partCount).toBeGreaterThan(1);

    // What we sent is kept, verbatim, for comparing with what Claru stored.
    expect(r.clips[0].submission.declared).toEqual(first.declared);
  }, 60_000);

  it('repeating a delivery never makes a second submission (externalRef is the idempotency key)', async () => {
    // Claru fails hard on the first try: the job gives up for now, keeps the error, and is retried.
    const id = await uploadAndDeclare(asha, 'wide', 3, undefined, { serverErrorsNext: 6 });
    let r = await recording(asha, id);
    expect(r.clips[0].submission.state).toBe('pending');
    expect(r.clips[0].submission.lastError).toMatch(/kept failing/);

    await db.query(`UPDATE jobs SET run_after = now() WHERE state = 'queued'`);
    await runJobs();
    await db.query(`UPDATE jobs SET run_after = now() WHERE state = 'queued'`);
    await runJobs();
    r = await recording(asha, id);
    expect(r.clips[0].submission).toMatchObject({ state: 'processing', lastError: null });
    expect(mockSubs().filter((s) => s.externalRef === `cvu-${id}-c01`)).toHaveLength(1);
  }, 60_000);

  it('obeys Retry-After on a rate limit and on SEAL_TIMEOUT, and seals once', async () => {
    const id = await uploadAndDeclare(asha, 'wide', 4, undefined, { rateLimitNext: 2, sealTimeouts: 1 });
    expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(3); // 2 × 429 + 1 × 503, each exactly Retry-After: 1
    expect((await recording(asha, id)).clips[0].submission.state).toBe('processing');
    expect(mockSubs()).toHaveLength(1);
    const calls = await db.query<{ status: number; code: string | null; note: string | null }>(`SELECT status, code, note FROM claru_calls WHERE status IN (429, 503)`);
    expect(calls.rows).toEqual(
      expect.arrayContaining([
        { status: 429, code: null, note: 'Retry-After 1' },
        { status: 503, code: 'SEAL_TIMEOUT', note: 'Retry-After 1' },
      ]),
    );
  }, 60_000);
});

describe('refused and rejected (two different things)', () => {
  it('a refusal keeps the reason and remedy; after a fix it is sent again under the SAME reference', async () => {
    const id = await uploadAndDeclare(asha, 'wide', 5, undefined, { refuseNextSeal: 'FROZEN' });
    let clip = (await recording(asha, id)).clips[0];
    expect(clip.submission).toMatchObject({ state: 'refused', refusal: { code: 'FROZEN', stage: 'seal' } });
    expect(clip.submission.refusal.remedy).toMatch(/picture stops changing/);

    // Nothing was created at Claru, so the declaration may still change …
    const again = await asha.post('/api/recordings/declaration', { shared: { ...SHARED, mount: 'head strap' }, items: [{ id, recordedAt: '2026-10-20T09:00:00+05:30', consent: ALL_TRUE }] });
    expect(again.status).toBe(200);
    // … and "Retry delivery" sends it under the same externalRef.
    expect((await asha.post(`/api/recordings/${id}/retry-delivery`)).status).toBe(200);
    await runJobs();
    clip = (await recording(asha, id)).clips[0];
    expect(clip.submission).toMatchObject({ state: 'processing', attempt: 1, externalRef: `cvu-${id}-c01` });
    const atClaru = mockSubs().filter((s) => s.externalRef === `cvu-${id}-c01`);
    expect(atClaru).toHaveLength(1);
    expect(atClaru[0]!.declared.mount).toBe('head strap');
  }, 60_000);

  it('polls for verdicts; a rejected clip can only go again under a NEW reference', async () => {
    const id = await uploadAndDeclare(asha, 'wide', 6);
    const ref = `cvu-${id}-c01`;
    // The admin plays Claru's reviewer through the test controls.
    const rej = await admin.post('/api/admin/claru/mock/review', { externalRef: ref, decision: 'reject', type: 'human', reason: 'Hands not visible.' });
    expect(rej.status).toBe(200);
    let clip = (await recording(asha, id)).clips[0];
    expect(clip.submission).toMatchObject({ state: 'rejected', rejection: { code: 'REVIEW_REJECTED', type: 'human', reason: 'Hands not visible.' } });
    expect(clip.submission.decidedAt).toBeTruthy();

    expect((await asha.post(`/api/recordings/${id}/retry-delivery`)).status).toBe(409); // not a refusal
    const re = await asha.post(`/api/recordings/${id}/clips/1/resubmit`);
    expect(re.body.externalRef).toBe(`${ref}-r2`);
    await runJobs();
    clip = (await recording(asha, id)).clips[0];
    expect(clip.submission).toMatchObject({ attempt: 2, externalRef: `${ref}-r2`, state: 'processing' });
    // Same bytes are fine: a rejected clip is invisible to Claru's duplicate check.
    expect(mockSubs().map((s) => s.state).sort()).toEqual(['processing', 'rejected']);

    await admin.post('/api/admin/claru/mock/review', { externalRef: `${ref}-r2`, decision: 'approve' });
    expect((await recording(asha, id)).clips[0].submission.state).toBe('approved');
  }, 60_000);

  it('a 403 from Claru (team or project problem) stops delivery and says why', async () => {
    const id = await uploadFile(asha, unique('wide', 7), 'w7.mp4');
    await runJobs();
    await asha.post('/api/recordings/declaration', { shared: SHARED, items: [{ id, recordedAt: '2026-10-20T09:00:00+05:30', consent: ALL_TRUE }] });
    await runJobs(client('00000000-0000-0000-0000-000000000000'));
    const clip = (await recording(asha, id)).clips[0];
    expect(clip.submission.lastError).toMatch(/PROJECT_NOT_ASSIGNED/);
    const problems = await admin.get('/api/admin/problems');
    expect(problems.body.problems[0].message).toMatch(/deliver failed.*PROJECT_NOT_ASSIGNED/);
  }, 60_000);
});

describe('the 72-hour review alert', () => {
  it('alerts at 72 h, reminds every 6 h once per interval, and closes when Claru decides', async () => {
    const id = await uploadAndDeclare(asha, 'wide', 8);
    const ref = `cvu-${id}-c01`;
    const ctx = { db, logger, review };
    const at = (hours: number) => db.query(`UPDATE submissions SET sealed_at = now() - make_interval(secs => $1::float8 * 3600) WHERE external_ref = $2`, [hours, ref]);

    await at(71);
    expect(await runReviewAlerts(ctx)).toMatchObject({ opened: 0, reminders: 0 });
    await at(73);
    expect(await runReviewAlerts(ctx)).toMatchObject({ opened: 1, reminders: 0 });
    expect(await runReviewAlerts(ctx)).toMatchObject({ opened: 0, reminders: 0 }); // same interval: nothing new
    await at(78.5);
    expect(await runReviewAlerts(ctx)).toMatchObject({ reminders: 1 }); // 72 + 6 crossed
    await at(80);
    expect(await runReviewAlerts(ctx)).toMatchObject({ reminders: 0 }); // still the 78–84 interval

    const overview = await admin.get('/api/admin/claru');
    expect(overview.body.alerts[0]).toMatchObject({ externalRef: ref, notifications: 2, uploader: 'asha', resolvedAt: null });
    expect((await recording(asha, id)).clips[0].submission.overdue).toBe(true);
    expect((await admin.post(`/api/admin/claru/alerts/${overview.body.alerts[0].id}/acknowledge`)).status).toBe(200);

    await admin.post('/api/admin/claru/mock/review', { externalRef: ref, decision: 'approve' });
    const after = await admin.get('/api/admin/claru');
    expect(after.body.alerts[0].resolvedAt).toBeTruthy();
    expect(after.body.alerts[0].acknowledgedBy).toBe('boss');
  }, 60_000);
});

describe('who may do what, and what stays frozen', () => {
  it('locks the declaration, the clips and the original once a clip is with Claru', async () => {
    const id = await uploadAndDeclare(asha, 'wide', 9);
    const change = await asha.post('/api/recordings/declaration', { shared: SHARED, items: [{ id, recordedAt: '2026-10-21T09:00:00+05:30', consent: ALL_TRUE }] });
    expect(change.status).toBe(409);
    expect((await asha.post(`/api/recordings/${id}/remove`)).status).toBe(409);
    expect((await asha.post(`/api/recordings/${id}/recheck`)).status).toBe(409);
  }, 60_000);

  it('consultants cannot touch others’ deliveries or the Claru admin page', async () => {
    const id = await uploadAndDeclare(asha, 'wide', 10);
    expect((await ravi.post(`/api/recordings/${id}/retry-delivery`)).status).toBe(404);
    expect((await ravi.post(`/api/recordings/${id}/clips/1/resubmit`)).status).toBe(404);
    expect((await asha.get('/api/admin/claru')).status).toBe(403);
    expect((await asha.post('/api/admin/claru/mock/review', { externalRef: `cvu-${id}-c01`, decision: 'approve' })).status).toBe(403);
  }, 60_000);

  it('the call log shows every call and never the API key or an upload URL', async () => {
    await uploadAndDeclare(asha, 'good', 11);
    const overview = await admin.get('/api/admin/claru');
    const paths = overview.body.calls.map((c: { method: string; path: string }) => `${c.method} ${c.path}`);
    expect(paths.some((p: string) => p === 'POST /supplier/submissions')).toBe(true);
    expect(paths.some((p: string) => /^PUT storage part \d+\/\d+$/.test(p))).toBe(true);
    expect(paths.some((p: string) => /\/parts\/.+\/complete$/.test(p))).toBe(true);
    expect(paths.some((p: string) => /\/seal$/.test(p))).toBe(true);
    const everything = JSON.stringify((await db.query('SELECT * FROM claru_calls')).rows) + JSON.stringify(overview.body);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('__storage');
  }, 60_000);
});

describe('when Claru no longer knows a sealed submission', () => {
  it('stops polling and alerting for it, and Retry delivery sends it again under the same reference', async () => {
    const id = await uploadAndDeclare(asha, 'wide', 12);
    const ref = `cvu-${id}-c01`;
    await fetch(`${mockOrigin}/__mock/reset`, { method: 'POST' }); // the mock forgets everything
    await db.query(`UPDATE submissions SET sealed_at = now() - interval '80 hours' WHERE external_ref = $1`, [ref]);

    await pollReviews({ db, logger, claru, review });
    let clip = (await recording(asha, id)).clips[0];
    expect(clip.submission).toMatchObject({ lost: true, state: 'processing', overdue: false });
    expect(clip.submission.lastError).toMatch(/does not know/);
    const before = (await db.query(`SELECT count(*)::int AS n FROM claru_calls`)).rows[0].n;
    await pollReviews({ db, logger, claru, review });
    expect((await db.query(`SELECT count(*)::int AS n FROM claru_calls`)).rows[0].n).toBe(before); // no more asking
    const overview = (await admin.get('/api/admin/claru')).body;
    expect(overview.alerts).toEqual([]);
    expect(overview.lost).toBe(1); // shown apart, not as "in review"
    expect(overview.counts.processing ?? 0).toBe(0);

    expect((await asha.post(`/api/recordings/${id}/retry-delivery`)).status).toBe(200);
    await runJobs();
    clip = (await recording(asha, id)).clips[0];
    expect(clip.submission).toMatchObject({ lost: false, state: 'processing', externalRef: ref, attempt: 1 });
    expect(mockSubs().map((s) => s.externalRef)).toEqual([ref]);
  }, 60_000);
});
