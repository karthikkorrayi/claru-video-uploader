import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
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
} from './helpers.js';

let db: pg.Pool;
let settings: UploadSettings;
let server: Server;
let base: string;
let admin: Client;
let asha: Client;
let ravi: Client;

async function consultant(username: string): Promise<Client> {
  await insertUser(db, { username, displayName: username, role: 'consultant', passwordHash: await hashPassword('Consultant-pass-42x'), mustChangePassword: false });
  const c = new Client(base);
  await c.login(username, 'Consultant-pass-42x');
  return c;
}

/** First video packet of a file: a clip must start on a keyframe. */
function firstPacketIsKeyframe(path: string): boolean {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'packet=flags', '-of', 'csv=p=0', path]);
  return String(out).trim().startsWith('K');
}

beforeAll(async () => {
  db = testPool();
  fixture('good'); // generate once, outside any test's time limit
  fixture('wide');
  fixture('bad');
  fixture('truncated');
}, 120_000);

afterAll(async () => {
  server?.close();
  await db.end();
  removeTestDirs();
});

beforeEach(async () => {
  server?.close();
  await resetDatabase(db);
  settings = testUploadSettings();
  ({ server, base } = await startApp(db, settings));
  await createAdmin(db);
  admin = new Client(base);
  await admin.login('boss', ADMIN_PASSWORD);
  asha = await consultant('asha');
  ravi = await consultant('ravi');
});

describe('after an upload: checks, then clips', () => {
  it('checks a good 65 s recording and cuts it into three equal clips, each starting on a keyframe', async () => {
    const id = await uploadAndProcess(asha, 'good', 'kitchen.mp4');
    const r = (await asha.get(`/api/recordings/${id}`)).body.recording;
    expect(r.checkStatus).toBe('passed');
    expect(r.problems).toEqual([]);
    expect(r.media).toMatchObject({ width: 1440, height: 1080, fps: 30, videoCodec: 'h264', hasAudio: true });
    expect(r.splitStatus).toBe('done');

    // Test rules are 10–30 s: 65 s → 3 clips of about 21.7 s, cut on the 1 s keyframes.
    expect(r.clips.map((c: { durationSeconds: number }) => Math.round(c.durationSeconds))).toEqual([21, 22, 22]);
    expect(r.clips.map((c: { externalRef: string }) => c.externalRef)).toEqual([1, 2, 3].map((n) => `cvu-${id}-c0${n}`));
    const total = r.clips.reduce((s: number, c: { durationSeconds: number }) => s + c.durationSeconds, 0);
    expect(Math.abs(total - 65)).toBeLessThan(0.2); // nothing lost, nothing doubled
    for (const c of r.clips) {
      const path = join(settings.workDir, id, 'clips', `c0${c.seq}.mp4`);
      expect(firstPacketIsKeyframe(path)).toBe(true);
      expect(statSync(path).size).toBe(c.sizeBytes);
    }
    expect(r.readyForDelivery).toBe(false); // not declared yet
  }, 60_000);

  it('accepts 16:9 with a warning and keeps a short recording as one clip, without copying it', async () => {
    const id = await uploadAndProcess(asha, 'wide', 'wide.mp4');
    const r = (await asha.get(`/api/recordings/${id}`)).body.recording;
    expect(r.checkStatus).toBe('warned');
    expect(r.problems).toEqual([expect.objectContaining({ code: 'ASPECT_RATIO', level: 'warn' })]);
    expect(r.clips).toHaveLength(1);
    const original = statSync(join(settings.workDir, id, 'original.mp4'));
    const clip = statSync(join(settings.workDir, id, 'clips', 'c01.mp4'));
    expect(clip.ino).toBe(original.ino); // a hard link: no extra disk space
  }, 60_000);

  it('fails a file Claru would refuse, lists every reason, and cuts nothing', async () => {
    const id = await uploadAndProcess(asha, 'bad', 'renamed.mp4');
    const r = (await asha.get(`/api/recordings/${id}`)).body.recording;
    expect(r.checkStatus).toBe('failed');
    const codes = r.problems.map((p: { level: string; code: string }) => `${p.level}:${p.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'error:CONTAINER_NOT_MP4',
        'error:RESOLUTION_TOO_LOW',
        'error:FRAME_RATE',
        'error:KEYFRAME_INTERVAL',
        'error:LOCATION_PRESENT',
        'error:AUTHOR_TAG_PRESENT',
        'error:CLIP_LENGTH',
        'warn:NO_AUDIO',
      ]),
    );
    expect(r.splitStatus).toBeNull();
    expect(r.clips).toEqual([]);
  }, 60_000);

  it('reports an incomplete file as unreadable instead of crashing', async () => {
    const id = await uploadAndProcess(asha, 'truncated', 'cut-short.mp4');
    const r = (await asha.get(`/api/recordings/${id}`)).body.recording;
    expect(r.checkStatus).toBe('failed');
    expect(r.problems[0]).toMatchObject({ code: 'VIDEO_UNREADABLE', level: 'error' });
  }, 60_000);

  it('deleting a recording deletes its clips; checking again rebuilds them', async () => {
    const id = await uploadAndProcess(asha, 'wide', 'wide.mp4');
    expect((await asha.post(`/api/recordings/${id}/recheck`)).status).toBe(200);
    expect((await asha.get(`/api/recordings/${id}`)).body.recording.checkStatus).toBe('pending');
    await runJobs(db, settings);
    expect((await asha.get(`/api/recordings/${id}`)).body.recording.clips).toHaveLength(1);

    expect((await ravi.post(`/api/recordings/${id}/recheck`)).status).toBe(404); // not Ravi's
    expect((await asha.post(`/api/recordings/${id}/remove`)).status).toBe(200);
    expect(existsSync(join(settings.workDir, id))).toBe(false);
    expect((await db.query('SELECT count(*)::int AS n FROM clips WHERE recording_id = $1', [id])).rows[0].n).toBe(0);
  }, 60_000);
});

async function uploadAndProcess(c: Client, name: 'good' | 'wide' | 'bad' | 'truncated', filename: string): Promise<string> {
  const { uploadFile } = await import('./helpers.js');
  const id = await uploadFile(c, fixture(name), filename);
  await runJobs(db, settings);
  return id;
}
