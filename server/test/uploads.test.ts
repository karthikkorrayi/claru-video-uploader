import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintFromSamples, fingerprintRanges } from '@cvu/shared';
import { hashPassword } from '../src/auth/password.js';
import { createLogger } from '../src/logger.js';
import type { UploadSettings } from '../src/uploads/context.js';
import { sweepUploads } from '../src/uploads/sweep.js';
import { insertUser } from '../src/users.js';
import {
  ADMIN_PASSWORD,
  Client,
  createAdmin,
  removeTestDirs,
  resetDatabase,
  startApp,
  testPool,
  testUploadSettings,
} from './helpers.js';

const MiB = 1024 * 1024;
const PASSWORD = 'Consultant-pass-42x';

let db: pg.Pool;
let settings: UploadSettings;
let server: Server;
let base: string;
let admin: Client;
let asha: Client;
let ravi: Client;

async function consultant(username: string): Promise<Client> {
  await insertUser(db, {
    username,
    displayName: username,
    role: 'consultant',
    passwordHash: await hashPassword(PASSWORD),
    mustChangePassword: false,
  });
  const c = new Client(base);
  expect((await c.login(username, PASSWORD)).status).toBe(200);
  return c;
}

async function fingerprint(buf: Buffer): Promise<string> {
  const { head, tail } = fingerprintRanges(buf.length);
  return fingerprintFromSamples(buf.length, buf.subarray(...head), buf.subarray(...tail));
}

async function declare(c: Client, buf: Buffer, filename = 'site-visit.mp4') {
  return c.post('/api/recordings', { filename, sizeBytes: buf.length, fingerprint: await fingerprint(buf) });
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

function createUpload(c: Client, id: string, size: number) {
  return c.tus('POST', '/api/uploads', { 'upload-length': String(size), 'upload-metadata': `recordingId ${b64(id)},filename ${b64('x.mp4')}` });
}

function patch(c: Client, id: string, offset: number, chunk: Buffer) {
  return c.tus('PATCH', `/api/uploads/${id}`, { 'upload-offset': String(offset) }, chunk);
}

/** Sends the whole file in 4 MiB chunks; returns the last response. */
async function sendAll(c: Client, id: string, buf: Buffer, from = 0): Promise<Response> {
  let res: Response | undefined;
  for (let off = from; off < buf.length; off += 4 * MiB) {
    res = await patch(c, id, off, buf.subarray(off, Math.min(off + 4 * MiB, buf.length)));
    if (res.status !== 204) return res;
  }
  return res!;
}

async function boot(s: UploadSettings = settings) {
  const started = await startApp(db, s);
  server = started.server;
  base = started.base;
}

beforeAll(async () => {
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
  settings = testUploadSettings();
  await boot();
  await createAdmin(db);
  admin = new Client(base);
  await admin.login('boss', ADMIN_PASSWORD);
  asha = await consultant('asha');
  ravi = await consultant('ravi');
});

describe('uploading a recording', () => {
  it('receives a file in chunks and keeps it as the original', async () => {
    const file = randomBytes(10 * MiB + 123);
    const d = await declare(asha, file);
    expect(d.status).toBe(201);
    expect(d.body.recording).toMatchObject({ transferStatus: 'waiting', sizeBytes: file.length, originalFilename: 'site-visit.mp4' });
    const id = d.body.recording.id as string;

    const created = await createUpload(asha, id, file.length);
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(`/api/uploads/${id}`);

    expect((await patch(asha, id, 0, file.subarray(0, 4 * MiB))).status).toBe(204);
    const mid = await asha.get(`/api/recordings/${id}`);
    expect(mid.body.recording).toMatchObject({ transferStatus: 'receiving', receivedBytes: 4 * MiB });

    expect((await sendAll(asha, id, file, 4 * MiB)).status).toBe(204);
    const done = await asha.get(`/api/recordings/${id}`);
    expect(done.body.recording).toMatchObject({ transferStatus: 'received', receivedBytes: file.length });
    expect(done.body.recording.averageBytesPerSecond).toBeGreaterThan(0);

    const stored = join(settings.workDir, id, 'original.mp4');
    expect(readFileSync(stored).equals(file)).toBe(true);
    expect(readdirSync(settings.tusDir)).toEqual([]);

    const audit = await admin.get('/api/admin/audit');
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['recording_created', 'upload_received']),
    );
  });

  it('continues where it stopped after the server restarts', async () => {
    const file = randomBytes(9 * MiB);
    const id = (await declare(asha, file)).body.recording.id as string;
    await createUpload(asha, id, file.length);
    await patch(asha, id, 0, file.subarray(0, 4 * MiB));

    server.close();
    await boot(); // same database, same folders, new process state
    asha = Object.assign(new Client(base), { cookie: asha.cookie });

    // The browser declares the same file again and gets the same recording back…
    const again = await declare(asha, file);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ resumed: true, recording: { id } });
    // …asks the server how much it has, and sends only the rest.
    const head = await asha.tus('HEAD', `/api/uploads/${id}`);
    expect(head.status).toBe(200);
    expect(head.headers.get('upload-offset')).toBe(String(4 * MiB));
    expect((await sendAll(asha, id, file, 4 * MiB)).status).toBe(204);
    expect(readFileSync(join(settings.workDir, id, 'original.mp4')).equals(file)).toBe(true);
  });

  it('rejects a file whose bytes do not match what the browser declared', async () => {
    const file = randomBytes(10 * MiB);
    const id = (await declare(asha, file)).body.recording.id as string;
    await createUpload(asha, id, file.length);
    const corrupted = Buffer.from(file);
    corrupted.writeUInt8(corrupted.readUInt8(corrupted.length - 1) ^ 0xff, corrupted.length - 1);
    const last = await sendAll(asha, id, corrupted);
    expect(last.status).toBe(422);
    const r = await asha.get(`/api/recordings/${id}`);
    expect(r.body.recording.transferStatus).toBe('failed');
    expect(r.body.recording.failureReason).toMatch(/fingerprint/);
    expect(readdirSync(settings.tusDir)).toEqual([]);
    expect(existsSync(join(settings.workDir, id))).toBe(false);
  });

  it('checks the declaration: MP4 only, size limit, fingerprint, free disk space', async () => {
    const file = randomBytes(MiB);
    const fp = await fingerprint(file);
    expect((await asha.post('/api/recordings', { filename: 'clip.mov', sizeBytes: MiB, fingerprint: fp })).body.error).toBe('not_mp4');
    expect((await asha.post('/api/recordings', { filename: 'a.MP4', sizeBytes: 65 * MiB, fingerprint: fp })).status).toBe(413);
    expect((await asha.post('/api/recordings', { filename: 'a.mp4', sizeBytes: MiB, fingerprint: 'abc' })).status).toBe(400);
    const pathy = await asha.post('/api/recordings', { filename: '../../etc/a.mp4', sizeBytes: MiB, fingerprint: fp });
    expect(pathy.body.recording.originalFilename).toBe('a.mp4');

    server.close();
    await boot(testUploadSettings({ diskReserveBytes: 2 ** 60 }));
    const c = Object.assign(new Client(base), { cookie: ravi.cookie });
    const full = await declare(c, randomBytes(MiB));
    expect(full.status).toBe(507);
    expect(full.body.error).toBe('insufficient_storage');
  });
});

describe('who may send bytes', () => {
  it('only the consultant who declared the recording, never anyone else', async () => {
    const file = randomBytes(5 * MiB);
    const id = (await declare(asha, file)).body.recording.id as string;

    // Someone else cannot start, probe, continue or delete Asha's upload.
    expect((await createUpload(ravi, id, file.length)).status).toBe(404);
    expect((await createUpload(admin, id, file.length)).status).toBe(404);
    expect((await createUpload(asha, id, file.length + 1)).status).toBe(400);
    expect((await createUpload(asha, id, file.length)).status).toBe(201);
    expect((await ravi.tus('HEAD', `/api/uploads/${id}`)).status).toBe(404);
    expect((await patch(ravi, id, 0, file.subarray(0, MiB))).status).toBe(404);
    expect((await patch(admin, id, 0, file.subarray(0, MiB))).status).toBe(404);
    expect((await asha.tus('DELETE', `/api/uploads/${id}`)).status).toBe(405);

    // No CSRF header, or not signed in: refused before tus sees it.
    const noCsrf = await fetch(`${base}/api/uploads/${id}`, {
      method: 'PATCH',
      headers: { cookie: asha.cookie, 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
      body: file.subarray(0, MiB),
    });
    expect(noCsrf.status).toBe(403);
    expect((await new Client(base).tus('HEAD', `/api/uploads/${id}`)).status).toBe(401);

    // Asha's own upload is untouched by all of that.
    expect((await sendAll(asha, id, file)).status).toBe(204);
  });
});

describe('who may see recordings', () => {
  it('consultants see only their own; the admin sees all', async () => {
    const a = (await declare(asha, randomBytes(MiB), 'asha.mp4')).body.recording.id as string;
    const r = (await declare(ravi, randomBytes(MiB), 'ravi.mp4')).body.recording.id as string;

    const ashaList = await asha.get('/api/recordings');
    expect(ashaList.body.recordings.map((x: { id: string }) => x.id)).toEqual([a]);
    expect((await asha.get(`/api/recordings/${r}`)).status).toBe(404);
    expect((await asha.post(`/api/recordings/${r}/cancel`)).status).toBe(404);
    expect((await asha.post(`/api/recordings/${r}/remove`)).status).toBe(404);
    expect((await asha.get('/api/recordings/not-a-uuid')).status).toBe(404);

    const all = await admin.get('/api/recordings');
    expect(all.body.recordings.map((x: { id: string }) => x.id).sort()).toEqual([a, r].sort());
    expect(all.body.recordings.find((x: { id: string }) => x.id === r).uploadedBy.username).toBe('ravi');
    expect((await admin.post(`/api/recordings/${r}/cancel`)).status).toBe(200);
  });
});

describe('the same file twice', () => {
  it('resumes for the same person, refuses for others, and refuses a second copy once received', async () => {
    const file = randomBytes(2 * MiB);
    const first = await declare(asha, file);
    const id = first.body.recording.id as string;

    expect((await declare(asha, file)).body).toMatchObject({ resumed: true, recording: { id } });
    expect((await declare(ravi, file)).body.error).toBe('duplicate_in_progress');

    await createUpload(asha, id, file.length);
    await sendAll(asha, id, file);

    const mine = await declare(asha, file);
    expect(mine.status).toBe(409);
    expect(mine.body).toMatchObject({ error: 'already_uploaded', recordingId: id });
    const theirs = await declare(ravi, file);
    expect(theirs.body.error).toBe('already_uploaded');
    expect(theirs.body.recordingId).toBeUndefined(); // no peeking at someone else's record

    // Once removed, the file can be uploaded afresh.
    expect((await asha.post(`/api/recordings/${id}/remove`)).status).toBe(200);
    expect(existsSync(join(settings.workDir, id))).toBe(false);
    expect((await declare(ravi, file)).status).toBe(201);
  });
});

describe('cancelling and housekeeping', () => {
  it('cancelling deletes what arrived and stops further chunks', async () => {
    const file = randomBytes(6 * MiB);
    const id = (await declare(asha, file)).body.recording.id as string;
    await createUpload(asha, id, file.length);
    await patch(asha, id, 0, file.subarray(0, 4 * MiB));
    expect(readdirSync(settings.tusDir).length).toBeGreaterThan(0);

    expect((await asha.post(`/api/recordings/${id}/cancel`)).status).toBe(200);
    expect(readdirSync(settings.tusDir)).toEqual([]);
    expect((await patch(asha, id, 4 * MiB, file.subarray(4 * MiB))).status).toBe(404);
    expect((await asha.post(`/api/recordings/${id}/cancel`)).body.error).toBe('wrong_state');
    expect((await asha.post(`/api/recordings/${id}/remove`)).body.error).toBe('wrong_state');
  });

  it('gives up uploads idle for 72 hours and completes ones whose last byte was never recorded', async () => {
    const ctx = { db, logger: createLogger('silent'), settings };

    const idle = randomBytes(5 * MiB);
    const idleId = (await declare(asha, idle)).body.recording.id as string;
    await createUpload(asha, idleId, idle.length);
    await patch(asha, idleId, 0, idle.subarray(0, MiB));
    await db.query(`UPDATE recordings SET last_progress_at = now() - interval '73 hours' WHERE id = $1`, [idleId]);

    // Simulate the server stopping right after the last byte was written.
    const whole = randomBytes(3 * MiB);
    const wholeId = (await declare(ravi, whole)).body.recording.id as string;
    await createUpload(ravi, wholeId, whole.length);
    writeFileSync(join(settings.tusDir, wholeId), whole);
    await db.query(`UPDATE recordings SET last_progress_at = now() - interval '5 minutes' WHERE id = $1`, [wholeId]);

    expect(await sweepUploads(ctx)).toEqual({ completed: 1, abandoned: 1 });

    const i = await asha.get(`/api/recordings/${idleId}`);
    expect(i.body.recording.transferStatus).toBe('abandoned');
    expect(existsSync(join(settings.tusDir, idleId))).toBe(false);
    const w = await ravi.get(`/api/recordings/${wholeId}`);
    expect(w.body.recording.transferStatus).toBe('received');
    expect(readFileSync(join(settings.workDir, wholeId, 'original.mp4')).equals(whole)).toBe(true);

    // The abandoned file can be uploaded again from the start.
    expect((await declare(asha, idle)).status).toBe(201);
  });
});
