// Mock of Claru's supplier API, built only from claru-integration.md (contract v2).
// It is NOT Claru: it stands in for it on your Mac and on the test server, so no
// test data ever reaches the real platform. What it reproduces, with the guide's
// section names:
//   1. Discover        GET  /supplier/projects
//   2. Create          POST /supplier/submissions          (idempotent on externalRef)
//   3. Upload          PUT  presigned URLs (single "put" or 64 MiB "multipart" slices)
//   4. Complete        POST /supplier/submissions/:id/parts/:partId/complete
//   5. Seal            POST /supplier/submissions/:id/seal  (refusals, replays, SEAL_TIMEOUT)
//   6. Poll            GET  /supplier/submissions[/:id]     (cursor paging, states)
//   + rate limit (429 + Retry-After), and test controls under /__mock (no key, loopback only).
// It does not read video files: media checks it cannot do are triggered by the
// /__mock/faults control instead (e.g. "refuse the next seal with FROZEN").
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import express, { type Request, type Response } from 'express';

export interface MockClaruOptions {
  apiKey: string;
  /** Multipart slice size handed out (guide: 64 MiB). Tests use smaller. */
  partSizeBytes?: number;
  /** Files up to this size get a single "put" (guide: "at or under 64 MiB"). */
  putThresholdBytes?: number;
  /** Seconds a sealed clip stays "processing" before "in_review". */
  processingSeconds?: number;
  /** Review the clip by itself after this many seconds in review (null = wait for /__mock/.../review). */
  autoReview?: { decision: 'approve' | 'reject'; afterSeconds: number } | null;
  /** Retry-After sent with 429 and SEAL_TIMEOUT (guide: 30 for SEAL_TIMEOUT). */
  retryAfterSeconds?: number;
  rateLimitPerMinute?: number;
  /** Keep submissions across restarts (the test server restarts the mock on every deploy). */
  stateFile?: string;
  /** The project's clip length rule (guide: 300–1800 s). Tests use shorter clips. */
  clipLength?: { minSeconds: number; maxSeconds: number };
  now?: () => number;
}

const MiB = 1024 * 1024;

/** The project from the guide's "Your projects"; category codes are mock samples. */
export const MOCK_PROJECT = {
  id: '92070f8b-acfb-44c2-8e73-1e6d9918a2b6',
  name: 'Commercial Egocentric Evaluation (RGB Supplier Upload)',
  checkGroups: { video: 'error', imu: 'off', stereo: 'off' },
  imuExpected: false,
  captureAspectRatio: '4_3',
  expectedFiles: [
    { fileType: 'video', required: true },
    { fileType: 'inputs', required: false },
    { fileType: 'other', required: false },
  ],
  clipLength: { minSeconds: 300, maxSeconds: 1800 },
  categories: [
    { code: 'MOCK-KITCHEN-PREP', name: 'Food preparation (mock)', parent: { id: 'mock-p1', name: 'Kitchen (mock)' } },
    { code: 'MOCK-WAREHOUSE-PICK', name: 'Picking (mock)', parent: { id: 'mock-p2', name: 'Warehouse (mock)' } },
  ],
  contractVersion: 2,
} as const;

/** details.remedy sentences, verbatim from the guide's "Every refusal code". */
export const REMEDIES: Record<string, string> = {
  PROJECT_NOT_ASSIGNED: 'Your team is not assigned to that project. Call GET /supplier/projects for the list you may submit to.',
  CATEGORY_UNKNOWN: 'That category code is not on this project. Refresh the project list with GET /supplier/projects.',
  PART_MISSING: 'Declare and upload every file the project lists as required.',
  PART_UNDECLARED: 'Send only the file types the project lists. Remove the extra part and seal again.',
  PART_NOT_UPLOADED: 'Finish uploading every declared part, then seal again.',
  PART_DUPLICATE_TYPE: 'Only `other` may repeat. Send one part per file type.',
  DUPLICATE_CONTENT: 'These bytes are already on the platform. Send a different clip.',
  SEAL_TIMEOUT: 'Seal did not finish in time. Retry the same seal call; nothing was created.',
  CONTRACT_VERSION_TOO_OLD: 'Your integration is below the accepted contract version. Re-download the integration guide.',
  CONSENT_INCOMPLETE: 'All four consent statements must be true for every clip. Do not submit footage you cannot affirm them for.',
  CONTAINER_NOT_MP4: 'Rewrap the video as .mp4 with a stream copy — `ffmpeg -i IN.MOV -map 0:v:0 -map 0:a? -c copy OUT.mp4`. Do not re-encode.',
  PART_SIZE_MISMATCH: 'The uploaded object is not the size you declared. Upload the whole file again; your bytes were left in place.',
  VIDEO_UNREADABLE: 'We could not read this file’s structure. Re-upload it — a truncated transfer is the usual cause — and deliver the camera file rewrapped with a stream copy, never an editor render.',
  RESOLUTION_TOO_LOW: 'Record at least 1080 pixels tall, in 4:3 or 16:9.',
  ASPECT_RATIO: 'Record in 4:3 or 16:9. Other aspect ratios are not accepted.',
  FRAME_RATE: 'Set the camera to 29.97, 30, 59.94 or 60 fps. PAL rates (25/50/100) are not accepted; on a GoPro set Preferences › General › Anti-Flicker to 60Hz.',
  KEYFRAME_INTERVAL: 'The camera must write a keyframe at least once per second. Do not re-encode with a longer GOP.',
  FRAME_GAP: 'The video has a gap longer than 100 ms. Deliver the recording without dropouts, and preserve the original frame timing when packaging.',
  ROTATION_TAG: 'Mount the camera upright and deliver a file with no rotation tag. Do not rotate in an editor — re-mux without the tag.',
  HDR: 'Turn HDR off at capture. 10-bit standard colour is fine; HLG and PQ are not.',
  LOCATION_PRESENT: 'Turn location off at capture. We refuse a clip that carries coordinates and never strip them for you.',
  AUTHOR_TAG_PRESENT: 'The file carries an artist/author tag, which means it went through an editor. Deliver the camera file, stream-copied.',
  CLIP_LENGTH: 'Split the recording into clips inside the project’s published length range, with a stream copy on keyframes.',
  FROZEN: 'The picture stops changing for part of this clip. Check the camera and re-record; splitting the same recording does not fix it.',
  PADDED_FRAME_RATE: 'This file reports a frame rate it does not deliver — repeated frames from an editor export. Deliver the camera file, stream-copied, never an editor render.',
};

/** Verdicts about the media move a submission to "refused"; the part-shape ones leave it a draft. */
const LEAVES_DRAFT = new Set(['PART_NOT_UPLOADED', 'PART_MISSING', 'PART_SIZE_MISMATCH']);

type State = 'draft' | 'processing' | 'in_review' | 'approved' | 'rejected' | 'refused' | 'expired';
const SEALED: State[] = ['processing', 'in_review', 'approved', 'rejected'];

interface Slot {
  size: number;
  md5: string;
  head: string; // first 16 bytes, hex (enough for the ftyp brand)
}

interface Part {
  partId: string;
  fileType: string;
  fileName: string;
  byteSize: number;
  uploadState: 'pending' | 'uploaded';
  kind: 'put' | 'multipart';
  uploadId: string | null;
  token: string;
  partCount: number;
  slots: Record<string, Slot>;
  /** Storage's checksum of the whole object (S3-style for multipart); used for DUPLICATE_CONTENT. */
  checksum: string | null;
  head: string | null;
}

interface Submission {
  id: string;
  externalRef: string;
  projectId: string;
  contractVersion: number;
  declared: Record<string, unknown>;
  parts: Part[];
  state: State;
  annotationId: string | null;
  seal: Record<string, unknown> | null;
  sealedAtMs: number | null;
  inReviewAtMs: number | null;
  lastRefusal: { code: string; message: string; at: string } | null;
  rejection: { code: string; type: 'machine' | 'human'; reason: string; checks?: string[] } | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Faults {
  sealTimeouts: number;
  refuseNextSeal: string | null;
  rateLimitNext: number;
  serverErrorsNext: number;
}

export interface MockClaruHandle extends express.Express {
  /** For tests: the stored submissions. */
  submissions(): Submission[];
}

export function createMockClaru(opts: MockClaruOptions): MockClaruHandle {
  const partSize = opts.partSizeBytes ?? 64 * MiB;
  const putThreshold = opts.putThresholdBytes ?? partSize;
  const processingSeconds = opts.processingSeconds ?? 20;
  const retryAfter = opts.retryAfterSeconds ?? 30;
  const ratePerMinute = opts.rateLimitPerMinute ?? 600;
  const now = opts.now ?? (() => Date.now());
  const clipLength = opts.clipLength ?? MOCK_PROJECT.clipLength;
  const project = { ...MOCK_PROJECT, clipLength };
  const iso = () => new Date(now()).toISOString();

  let subs: Submission[] = [];
  let seq = 0;
  const faults: Faults = { sealTimeouts: 0, refuseNextSeal: null, rateLimitNext: 0, serverErrorsNext: 0 };
  let autoReview = opts.autoReview ?? null;
  const calls: number[] = [];

  if (opts.stateFile && existsSync(opts.stateFile)) {
    const saved = JSON.parse(readFileSync(opts.stateFile, 'utf8')) as { subs: Submission[]; seq: number };
    subs = saved.subs;
    seq = saved.seq;
  }
  let saveWarned = false;
  function save(): void {
    if (!opts.stateFile) return;
    try {
      mkdirSync(dirname(opts.stateFile), { recursive: true });
      const tmp = `${opts.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ subs, seq }));
      renameSync(tmp, opts.stateFile);
    } catch (err) {
      // Keep answering from memory; only persistence across restarts is lost.
      if (!saveWarned) console.error(`mock Claru: cannot save state to ${opts.stateFile} (${(err as Error).message}); keeping it in memory`);
      saveWarned = true;
    }
  }

  /** Time moves clips along: processing → in_review → (auto review, if switched on). */
  function advance(s: Submission): void {
    const t = now();
    if (s.state === 'processing' && s.sealedAtMs !== null && t - s.sealedAtMs >= processingSeconds * 1000) {
      s.state = 'in_review';
      s.inReviewAtMs = s.sealedAtMs + processingSeconds * 1000;
      s.updatedAt = new Date(s.inReviewAtMs).toISOString();
    }
    if (s.state === 'in_review' && autoReview && s.inReviewAtMs !== null && t - s.inReviewAtMs >= autoReview.afterSeconds * 1000) {
      review(s, autoReview.decision === 'approve' ? { decision: 'approve' } : { decision: 'reject' });
    }
  }

  function review(s: Submission, r: { decision: 'approve' | 'reject'; type?: 'machine' | 'human'; code?: string; reason?: string; checks?: string[] }): void {
    if (r.decision === 'approve') {
      s.state = 'approved';
      s.rejection = null;
    } else {
      const type = r.type ?? 'human';
      const code = r.code ?? (type === 'human' ? 'REVIEW_REJECTED' : 'QA_FROZEN');
      s.state = 'rejected';
      s.rejection = {
        code,
        type,
        reason: r.reason ?? (type === 'human' ? 'The activity is not visible for most of the clip. (mock reviewer)' : 'Your video needs 1 fix before it can be reviewed:\n• The picture stops changing. (mock)'),
        ...(code.startsWith('QA_') ? { checks: r.checks ?? [code.slice(3).toLowerCase()] } : {}),
      };
    }
    s.updatedAt = iso();
  }

  function uploadFor(s: Submission, p: Part, host: string): Record<string, unknown> {
    const expiresAt = new Date(now() + 6 * 3600_000).toISOString();
    const base = `http://${host}/__storage/${p.token}`;
    if (p.kind === 'put') {
      const headers: Record<string, string> = { 'x-amz-meta-source': 'supplier_upload' };
      const type = { video: 'video/mp4', video_right: 'video/mp4', inputs: 'text/csv', calibration: 'application/json' }[p.fileType];
      if (type) headers['content-type'] = type;
      return { kind: 'put', url: `${base}/put`, headers, expiresAt };
    }
    return {
      kind: 'multipart',
      uploadId: p.uploadId,
      partSizeBytes: partSize,
      parts: Array.from({ length: p.partCount }, (_, i) => ({ partNumber: i + 1, url: `${base}/${i + 1}` })),
      headers: {},
      expiresAt,
    };
  }

  function body(s: Submission, opt: { host?: string; declared?: boolean } = {}): Record<string, unknown> {
    return {
      id: s.id,
      externalRef: s.externalRef,
      projectId: s.projectId,
      state: s.state,
      sealed: SEALED.includes(s.state),
      contractVersion: s.contractVersion,
      ...(s.annotationId ? { annotationId: s.annotationId } : {}),
      ...(s.seal ? { seal: s.seal } : {}),
      ...(s.lastRefusal ? { lastRefusal: s.lastRefusal } : {}),
      ...(s.rejection ? { rejection: s.rejection, hint: 'resubmit the corrected clip under a new externalRef' } : {}),
      parts: s.parts.map((p) => ({
        partId: p.partId,
        fileType: p.fileType,
        fileName: p.fileName,
        byteSize: p.byteSize,
        uploadState: p.uploadState,
        ...(opt.host && p.uploadState === 'pending' && s.state === 'draft' ? { upload: uploadFor(s, p, opt.host) } : {}),
      })),
      ...(opt.declared ? { declared: s.declared } : {}),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  function newPart(p: { fileType: string; fileName: string; byteSize: number }): Part {
    const multipart = p.byteSize > putThreshold;
    return {
      partId: randomUUID(),
      fileType: p.fileType,
      fileName: p.fileName,
      byteSize: p.byteSize,
      uploadState: 'pending',
      kind: multipart ? 'multipart' : 'put',
      uploadId: multipart ? randomBytes(12).toString('hex') : null,
      token: randomBytes(16).toString('hex'),
      partCount: multipart ? Math.ceil(p.byteSize / partSize) : 1,
      slots: {},
      checksum: null,
      head: null,
    };
  }

  const fail = (res: Response, status: number, code: string | null, message: string, details: Record<string, unknown> = {}) => {
    if (code) res.status(status).json({ statusCode: status, message, code, details: { remedy: REMEDIES[code] ?? '', ...details } });
    else res.status(status).json({ statusCode: status, message });
  };

  const app = express() as MockClaruHandle;
  app.disable('x-powered-by');
  app.submissions = () => subs;

  app.get('/__mock/health', (_req, res) => {
    res.json({ ok: true, service: 'mock-claru' });
  });

  // ---- Storage (the presigned URLs). No API key, no rate limit — like S3. ----
  app.put('/__storage/:token/:slot', (req, res) => {
    const part = subs.flatMap((s) => s.parts.map((p) => ({ s, p }))).find((x) => x.p.token === req.params.token);
    if (!part) {
      res.status(403).type('application/xml').send('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    const signed = Object.keys(req.headers).some((h) => h.startsWith('x-amz-checksum-') || h === 'x-amz-sdk-checksum-algorithm');
    if (signed || (part.p.kind === 'put' && req.get('x-amz-meta-source') !== 'supplier_upload')) {
      res.status(403).type('application/xml').send('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    const slot = req.params.slot === 'put' ? '1' : req.params.slot;
    const n = Number(slot);
    if (!(n >= 1 && n <= part.p.partCount)) {
      res.status(400).type('application/xml').send('<Error><Code>InvalidPart</Code></Error>');
      return;
    }
    const md5 = createHash('md5');
    let size = 0;
    let head = Buffer.alloc(0);
    req.on('data', (chunk: Buffer) => {
      md5.update(chunk);
      size += chunk.length;
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
    });
    req.on('end', () => {
      const digest = md5.digest('hex');
      part.p.slots[slot] = { size, md5: digest, head: head.toString('hex') };
      save();
      res.set('ETag', `"${digest}"`).status(200).end();
    });
  });

  // ---- Test controls (no key; the mock listens on 127.0.0.1 only). ----
  app.use('/__mock', express.json({ limit: '100kb' }));
  app.get('/__mock/submissions', (_req, res) => {
    subs.forEach(advance);
    res.json({ items: subs.map((s) => body(s, { declared: true })), faults, autoReview });
  });
  app.post('/__mock/submissions/:id/review', (req, res) => {
    const s = subs.find((x) => x.id === req.params.id);
    if (!s) return fail(res, 404, null, 'Not Found');
    advance(s);
    if (s.state !== 'processing' && s.state !== 'in_review') return fail(res, 409, null, `Only a sealed clip waiting for review can be reviewed (state: ${s.state})`);
    const b = req.body as { decision?: string; type?: 'machine' | 'human'; code?: string; reason?: string; checks?: string[] };
    if (b.decision !== 'approve' && b.decision !== 'reject') return fail(res, 400, null, 'decision must be approve or reject');
    review(s, { ...b, decision: b.decision });
    save();
    res.json(body(s, { declared: true }));
  });
  app.post('/__mock/faults', (req, res) => {
    const b = req.body as Partial<Faults> & { autoReview?: MockClaruOptions['autoReview'] };
    if (b.sealTimeouts !== undefined) faults.sealTimeouts = Number(b.sealTimeouts) || 0;
    if (b.refuseNextSeal !== undefined) faults.refuseNextSeal = b.refuseNextSeal || null;
    if (b.rateLimitNext !== undefined) faults.rateLimitNext = Number(b.rateLimitNext) || 0;
    if (b.serverErrorsNext !== undefined) faults.serverErrorsNext = Number(b.serverErrorsNext) || 0;
    if (b.autoReview !== undefined) autoReview = b.autoReview;
    res.json({ faults, autoReview });
  });
  app.post('/__mock/reset', (_req, res) => {
    subs = [];
    seq = 0;
    Object.assign(faults, { sealTimeouts: 0, refuseNextSeal: null, rateLimitNext: 0, serverErrorsNext: 0 });
    autoReview = opts.autoReview ?? null;
    save();
    res.json({ ok: true });
  });

  // ---- The API ----
  app.use(express.json({ limit: '1mb' }));

  // Every API call carries x-api-key; a wrong or missing key is a plain 401 with no code.
  app.use('/api/v1', (req, res, next) => {
    if (req.get('x-api-key') !== opts.apiKey) return fail(res, 401, null, 'Unauthorized');
    const t = now();
    while (calls.length && t - calls[0]! > 60_000) calls.shift();
    calls.push(t);
    if (faults.rateLimitNext > 0 || calls.length > ratePerMinute) {
      if (faults.rateLimitNext > 0) faults.rateLimitNext--;
      res.set('Retry-After', String(retryAfter));
      return fail(res, 429, null, 'Too Many Requests');
    }
    if (faults.serverErrorsNext > 0) {
      faults.serverErrorsNext--;
      return fail(res, 500, null, 'Internal Server Error');
    }
    next();
  });

  app.get('/api/v1/supplier/projects', (_req, res) => {
    res.json({
      team: { id: 'mock-team', name: 'Veda solutions (mock)', status: 'active' },
      contract: { version: 2, minAcceptedVersion: 1 },
      rateLimit: { requestsPerMinute: ratePerMinute },
      projects: [project],
    });
  });

  app.post('/api/v1/supplier/submissions', (req: Request, res: Response) => {
    const b = req.body as {
      projectId?: string;
      externalRef?: string;
      contractVersion?: number;
      declared?: Record<string, unknown>;
      parts?: Array<{ fileType?: string; fileName?: string; byteSize?: number }>;
    };
    if (!b || typeof b.externalRef !== 'string' || !b.externalRef || b.externalRef.length > 128 || !b.declared || !Array.isArray(b.parts) || !b.parts.length) {
      return fail(res, 400, null, 'projectId, externalRef, contractVersion, declared and parts are required');
    }
    for (const p of b.parts) {
      if (typeof p.fileType !== 'string' || typeof p.fileName !== 'string' || !Number.isInteger(p.byteSize) || (p.byteSize ?? 0) <= 0) {
        return fail(res, 400, null, 'each part needs fileType, fileName and a positive integer byteSize');
      }
    }
    if (b.projectId !== MOCK_PROJECT.id) return fail(res, 403, 'PROJECT_NOT_ASSIGNED', 'Project not assigned');
    if (!Number.isInteger(b.contractVersion) || (b.contractVersion ?? 0) < 1) return fail(res, 422, 'CONTRACT_VERSION_TOO_OLD', 'Contract version too old');
    const codes: string[] = MOCK_PROJECT.categories.map((c) => c.code);
    if (!codes.includes(String(b.declared.categoryCode))) return fail(res, 422, 'CATEGORY_UNKNOWN', 'Unknown category', { categoryCode: b.declared.categoryCode });
    const video = b.parts.find((p) => p.fileType === 'video');
    if (video && !/\.mp4$/i.test(video.fileName!)) return fail(res, 422, 'CONTAINER_NOT_MP4', 'Container not mp4');

    const existing = subs.find((s) => s.externalRef === b.externalRef);
    if (existing) {
      advance(existing);
      if (SEALED.includes(existing.state)) return res.json(body(existing, { host: req.get('host') }));
      // A draft, a refused or an expired submission: replace the declaration and the part list in place.
      // Files that already landed (same type and size) are kept; the rest get fresh URLs.
      existing.declared = b.declared;
      existing.contractVersion = b.contractVersion!;
      existing.parts = b.parts.map((p) => {
        const kept = existing.parts.find((o) => o.fileType === p.fileType && o.byteSize === p.byteSize && o.fileName === p.fileName);
        if (kept && kept.uploadState === 'uploaded') return kept;
        if (kept) {
          // Same file still pending: a multipart upload keeps its id unless a failed complete spent it.
          const spent = kept.kind === 'multipart' && kept.uploadId === null;
          // Earlier URLs stay valid until they expire (as presigned URLs do), unless the upload id was spent.
          return spent ? { ...kept, token: randomBytes(16).toString('hex'), uploadId: randomBytes(12).toString('hex'), slots: {} } : kept;
        }
        return newPart(p as { fileType: string; fileName: string; byteSize: number });
      });
      existing.state = 'draft';
      existing.updatedAt = iso();
      save();
      return res.json(body(existing, { host: req.get('host') }));
    }

    const s: Submission = {
      id: randomUUID(),
      externalRef: b.externalRef,
      projectId: b.projectId!,
      contractVersion: b.contractVersion!,
      declared: b.declared,
      parts: b.parts.map((p) => newPart(p as { fileType: string; fileName: string; byteSize: number })),
      state: 'draft',
      annotationId: null,
      seal: null,
      sealedAtMs: null,
      inReviewAtMs: null,
      lastRefusal: null,
      rejection: null,
      createdAt: iso(),
      updatedAt: iso(),
      seq: ++seq,
    };
    subs.push(s);
    save();
    res.json(body(s, { host: req.get('host') }));
  });

  app.post('/api/v1/supplier/submissions/:id/parts/:partId/complete', (req, res) => {
    const s = subs.find((x) => x.id === req.params.id);
    const p = s?.parts.find((x) => x.partId === req.params.partId);
    if (!s || !p) return fail(res, 404, null, 'Not Found');
    if (p.uploadState === 'uploaded') return res.json(body(s));
    if (p.kind === 'put') {
      const got = p.slots['1'];
      if (!got || got.size !== p.byteSize) return fail(res, 422, 'PART_SIZE_MISMATCH', 'Size mismatch', { declared: p.byteSize, landed: got?.size ?? 0 });
      p.checksum = got.md5;
      p.head = got.head;
    } else {
      const listed = ((req.body ?? {}) as { parts?: Array<{ partNumber: number; etag: string }> }).parts ?? [];
      const sorted = [...listed].sort((a, b) => a.partNumber - b.partNumber);
      const complete = sorted.length === p.partCount && sorted.every((x, i) => x.partNumber === i + 1);
      const etagsMatch = complete && sorted.every((x) => p.slots[String(x.partNumber)] && x.etag.replaceAll('"', '') === p.slots[String(x.partNumber)]!.md5);
      if (!etagsMatch) return fail(res, 400, null, 'InvalidPart: every part number with the ETag its PUT returned is required');
      const total = sorted.reduce((sum, x) => sum + p.slots[String(x.partNumber)]!.size, 0);
      if (total !== p.byteSize) {
        p.uploadId = null; // a completed multipart upload has spent its id; a replay mints a fresh one
        p.slots = {};
        return fail(res, 422, 'PART_SIZE_MISMATCH', 'Size mismatch', { declared: p.byteSize, landed: total });
      }
      const joined = createHash('md5');
      for (const x of sorted) joined.update(Buffer.from(p.slots[String(x.partNumber)]!.md5, 'hex'));
      p.checksum = `${joined.digest('hex')}-${p.partCount}`;
      p.head = p.slots['1']!.head;
    }
    p.uploadState = 'uploaded';
    s.updatedAt = iso();
    save();
    res.json(body(s));
  });

  app.post('/api/v1/supplier/submissions/:id/seal', (req, res) => {
    const s = subs.find((x) => x.id === req.params.id);
    if (!s) return fail(res, 404, null, 'Not Found');
    advance(s);
    if (SEALED.includes(s.state)) return res.json(body(s)); // a replay: nothing is redone

    if (faults.sealTimeouts > 0) {
      faults.sealTimeouts--;
      res.set('Retry-After', String(retryAfter));
      return fail(res, 503, 'SEAL_TIMEOUT', 'Seal timed out', { retryAfterSeconds: retryAfter });
    }

    const refusals: string[] = [];
    const video = s.parts.find((p) => p.fileType === 'video');
    if (!video) refusals.push('PART_MISSING');
    if (s.parts.some((p) => p.uploadState !== 'uploaded')) refusals.push('PART_NOT_UPLOADED');
    const types = s.parts.map((p) => p.fileType).filter((t) => t !== 'other');
    if (new Set(types).size !== types.length) refusals.push('PART_DUPLICATE_TYPE');
    if (s.parts.some((p) => !['video', 'inputs', 'other'].includes(p.fileType))) refusals.push('PART_UNDECLARED');
    if (!refusals.length) {
      const consent = (s.declared.consent ?? {}) as Record<string, unknown>;
      const keys = ['worker_consent_obtained', 'site_or_employer_permission_obtained', 'required_consent_or_notice_process_followed', 'footage_unedited'];
      if (!keys.every((k) => consent[k] === true)) refusals.push('CONSENT_INCOMPLETE');
      const brand = video?.head ? Buffer.from(video.head, 'hex') : Buffer.alloc(0);
      if (brand.subarray(4, 8).toString('latin1') !== 'ftyp') refusals.push('VIDEO_UNREADABLE');
      else if (brand.subarray(8, 12).toString('latin1') === 'qt  ') refusals.push('CONTAINER_NOT_MP4');
      const d = Number(s.declared.durationSeconds);
      if (!(d >= clipLength.minSeconds && d <= clipLength.maxSeconds)) refusals.push('CLIP_LENGTH');
      if (faults.refuseNextSeal) {
        refusals.push(faults.refuseNextSeal);
        faults.refuseNextSeal = null;
      }
    }
    const twin = refusals.length ? undefined : subs.find((o) => o !== s && o.state !== 'rejected' && SEALED.includes(o.state) && o.parts.find((p) => p.fileType === 'video')?.checksum === video?.checksum);
    if (twin) refusals.push('DUPLICATE_CONTENT');

    if (refusals.length) {
      const code = refusals[0]!;
      const details: Record<string, unknown> = refusals.length > 1 ? { refusals: refusals.map((c) => ({ code: c, remedy: REMEDIES[c] ?? '' })) } : {};
      if (code === 'DUPLICATE_CONTENT' && twin) Object.assign(details, { submissionId: twin.id, externalRef: twin.externalRef });
      s.lastRefusal = { code, message: `Refused: ${code}`, at: iso() };
      if (!LEAVES_DRAFT.has(code)) s.state = 'refused';
      s.updatedAt = iso();
      save();
      return fail(res, 422, code, `Refused: ${code}`, details);
    }

    s.state = 'processing';
    s.sealedAtMs = now();
    s.annotationId = randomUUID();
    s.seal = { at: iso(), warnings: [], duplicateCheck: 'clear', sensorSetAside: false };
    s.updatedAt = iso();
    save();
    res.json(body(s));
  });

  app.get('/api/v1/supplier/submissions/:id', (req, res) => {
    const s = subs.find((x) => x.id === req.params.id);
    if (!s) return fail(res, 404, null, 'Not Found');
    advance(s);
    res.json(body(s, { declared: true }));
  });

  // Newest first, cursor-paged; filters state, projectId, externalRef.
  app.get('/api/v1/supplier/submissions', (req, res) => {
    subs.forEach(advance);
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const list = subs
      .filter((s) => (!q.state || s.state === q.state) && (!q.projectId || s.projectId === q.projectId) && (!q.externalRef || s.externalRef === q.externalRef))
      .sort((a, b) => b.seq - a.seq);
    let start = 0;
    if (q.cursor) {
      const after = Number(Buffer.from(q.cursor, 'base64url').toString('utf8').replace(/^seq:/, ''));
      const idx = list.findIndex((s) => s.seq === after);
      if (!Number.isFinite(after) || idx === -1) return fail(res, 400, 'INVALID_CURSOR', 'Invalid cursor');
      start = idx + 1;
    }
    const page = list.slice(start, start + limit);
    const more = start + limit < list.length;
    res.json({ items: page.map((s) => body(s)), ...(more ? { nextCursor: Buffer.from(`seq:${page[page.length - 1]!.seq}`).toString('base64url') } : {}) });
  });

  app.use((_req, res) => {
    fail(res, 404, null, 'Not Found');
  });

  return app;
}
