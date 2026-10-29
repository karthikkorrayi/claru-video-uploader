import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockClaru, MOCK_PROJECT } from '../src/claru.js';

interface ProjectsResponse {
  team: { status: string };
  contract: { version: number; minAcceptedVersion: number };
  rateLimit: { requestsPerMinute: number };
  projects: Array<{ id: string; clipLength: { minSeconds: number; maxSeconds: number }; checkGroups: { imu: string } }>;
}

let server: Server;
let base = '';

beforeAll(async () => {
  server = createMockClaru({ apiKey: 'test-key' }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

describe('mock Claru discovery', () => {
  it('rejects a missing key with a plain 401', async () => {
    const res = await fetch(`${base}/api/v1/supplier/projects`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ statusCode: 401, message: 'Unauthorized' });
  });

  it('lists the project from the guide with the right key', async () => {
    const res = await fetch(`${base}/api/v1/supplier/projects`, { headers: { 'x-api-key': 'test-key' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectsResponse;
    const project = body.projects[0];
    expect(body.team.status).toBe('active');
    expect(body.contract).toEqual({ version: 2, minAcceptedVersion: 1 });
    expect(body.rateLimit.requestsPerMinute).toBe(600);
    expect(project?.id).toBe(MOCK_PROJECT.id);
    expect(project?.clipLength).toEqual({ minSeconds: 300, maxSeconds: 1800 });
    expect(project?.checkGroups.imu).toBe('off');
  });
});

describe('mock Claru delivery (steps 2–6 of the guide)', () => {
  const MiB = 1024 * 1024;
  let t = Date.parse('2026-10-26T10:00:00Z');
  let srv: Server;
  let url = '';
  const H = { 'x-api-key': 'k', 'content-type': 'application/json' };
  const mp4 = (size: number) => {
    const b = Buffer.alloc(size, 7);
    b.write('ftypisom', 4, 'latin1');
    return b;
  };
  const declared = {
    categoryCode: 'MOCK-KITCHEN-PREP',
    country: 'IN',
    collectorId: 'asha',
    siteId: 's1',
    device: 'GoPro HERO12 Black',
    mount: 'chest harness',
    recordedAt: '2026-10-20T03:30:00Z',
    durationSeconds: 600,
    consent: { worker_consent_obtained: true, site_or_employer_permission_obtained: true, required_consent_or_notice_process_followed: true, footage_unedited: true },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked field by field
  type Any = any;
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Any; headers: Headers }> => {
    const r = await fetch(`${url}/api/v1${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const create = (ref: string, size: number, extra: Record<string, unknown> = {}) =>
    api('POST', '/supplier/submissions', { projectId: MOCK_PROJECT.id, externalRef: ref, contractVersion: 2, declared: { ...declared, ...extra }, parts: [{ fileType: 'video', fileName: `${ref}.mp4`, byteSize: size }] });
  async function uploadAll(sub: Any, data: Buffer): Promise<void> {
    const part = sub.parts[0];
    if (part.upload.kind === 'put') {
      expect((await fetch(part.upload.url, { method: 'PUT', headers: part.upload.headers, body: data })).status).toBe(200);
      expect((await api('POST', `/supplier/submissions/${sub.id}/parts/${part.partId}/complete`, {})).status).toBe(200);
      return;
    }
    const size = part.upload.partSizeBytes;
    const done = [];
    for (const p of part.upload.parts) {
      const r = await fetch(p.url, { method: 'PUT', body: data.subarray((p.partNumber - 1) * size, p.partNumber * size) });
      done.push({ partNumber: p.partNumber, etag: r.headers.get('etag') });
    }
    expect((await api('POST', `/supplier/submissions/${sub.id}/parts/${part.partId}/complete`, { parts: done })).status).toBe(200);
  }

  beforeAll(async () => {
    const m = createMockClaru({ apiKey: 'k', partSizeBytes: MiB, putThresholdBytes: MiB, processingSeconds: 60, now: () => t });
    srv = m.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    srv.close();
  });

  it('creates once per externalRef, uploads both shapes, seals, and replays a seal', async () => {
    const a = await create('ref-a', 2 * MiB + 5);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ state: 'draft', sealed: false });
    expect(a.body.parts[0].upload).toMatchObject({ kind: 'multipart', partSizeBytes: MiB });
    expect(a.body.parts[0].upload.parts).toHaveLength(3);
    expect((await create('ref-a', 2 * MiB + 5)).body.id).toBe(a.body.id); // same ref, same submission
    await uploadAll(a.body, mp4(2 * MiB + 5));
    const sealed = await api('POST', `/supplier/submissions/${a.body.id}/seal`);
    expect(sealed.body).toMatchObject({ state: 'processing', sealed: true, seal: { duplicateCheck: 'clear', warnings: [] } });
    const replay = await api('POST', `/supplier/submissions/${a.body.id}/seal`);
    expect(replay.body.annotationId).toBe(sealed.body.annotationId); // nothing redone
    t += 61_000;
    expect((await api('GET', `/supplier/submissions/${a.body.id}`)).body).toMatchObject({ state: 'in_review', declared });
  });

  it('enforces the upload rules: signed header on a put, no checksum headers, sizes and ETags must match', async () => {
    const b = await create('ref-b', 1000);
    const up = b.body.parts[0].upload;
    expect(up).toMatchObject({ kind: 'put', headers: { 'x-amz-meta-source': 'supplier_upload', 'content-type': 'video/mp4' } });
    expect((await fetch(up.url, { method: 'PUT', body: mp4(1000) })).status).toBe(403); // header left out
    expect((await fetch(up.url, { method: 'PUT', headers: { ...up.headers, 'x-amz-checksum-crc32': 'x' }, body: mp4(1000) })).status).toBe(403);
    await fetch(up.url, { method: 'PUT', headers: up.headers, body: mp4(999) });
    const short = await api('POST', `/supplier/submissions/${b.body.id}/parts/${b.body.parts[0].partId}/complete`, {});
    expect(short.body).toMatchObject({ statusCode: 422, code: 'PART_SIZE_MISMATCH' });
    expect(short.body.details.remedy).toMatch(/Upload the whole file again/);
    expect((await api('POST', `/supplier/submissions/${b.body.id}/seal`)).body.code).toBe('PART_NOT_UPLOADED');
    expect((await api('GET', `/supplier/submissions/${b.body.id}`)).body.state).toBe('draft'); // a part problem leaves a draft
  });

  it('refuses at the door (state refused, lastRefusal kept) and lets the same ref try again', async () => {
    const c = await create('ref-c', 500, { consent: { ...declared.consent, footage_unedited: false } });
    await uploadAll(c.body, mp4(500));
    const r = await api('POST', `/supplier/submissions/${c.body.id}/seal`);
    expect(r.body).toMatchObject({ statusCode: 422, code: 'CONSENT_INCOMPLETE' });
    expect((await api('GET', `/supplier/submissions/${c.body.id}`)).body).toMatchObject({ state: 'refused', lastRefusal: { code: 'CONSENT_INCOMPLETE' } });
    const again = await create('ref-c', 500);
    expect(again.body).toMatchObject({ id: c.body.id, state: 'draft' });
    expect(again.body.parts[0].uploadState).toBe('uploaded'); // the bytes stayed where they were
    expect((await api('POST', `/supplier/submissions/${c.body.id}/seal`)).body.state).toBe('processing');
  });

  it('refuses a .mov wrapper, an unknown category and exact duplicates', async () => {
    expect((await create('ref-d', 500, { categoryCode: 'K-99' })).body.code).toBe('CATEGORY_UNKNOWN');
    const mov = await create('ref-e', 500);
    const qt = mp4(500);
    qt.write('ftypqt  ', 4, 'latin1');
    await uploadAll(mov.body, qt);
    expect((await api('POST', `/supplier/submissions/${mov.body.id}/seal`)).body.code).toBe('CONTAINER_NOT_MP4');
    const twin = await create('ref-f', 2 * MiB + 5); // same bytes as ref-a, which is sealed
    await uploadAll(twin.body, mp4(2 * MiB + 5));
    const dup = await api('POST', `/supplier/submissions/${twin.body.id}/seal`);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE_CONTENT', details: { externalRef: 'ref-a' } });
  });

  it('lists newest first with a cursor, and rejects a cursor it did not issue', async () => {
    const page1 = await api('GET', '/supplier/submissions?limit=2');
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await api('GET', `/supplier/submissions?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    expect((await api('GET', '/supplier/submissions?cursor=bogus')).body.code).toBe('INVALID_CURSOR');
    expect((await api('GET', '/supplier/submissions?state=refused')).body.items.map((s: Any) => s.externalRef)).toEqual(['ref-f', 'ref-e']);
  });
});
