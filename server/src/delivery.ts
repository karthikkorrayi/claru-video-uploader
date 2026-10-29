import { open } from 'node:fs/promises';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { ClaruClient } from './claru/client.js';
import { enqueue, type JobRow } from './jobs.js';
import { consentComplete, findRecordingById, type RecordingRow } from './recordings.js';

export interface DeliveryCtx {
  db: pg.Pool;
  logger: Logger;
  claru: ClaruClient;
  /** Called when Claru refuses a category, so the form's list is refreshed. */
  refreshProject?: () => Promise<unknown>;
}

/** Thrown for 403s: the team or project is the problem, not the clip. Stops every delivery. */
export class TeamProblem extends Error {}

interface ClipRow {
  id: string;
  seq: number;
  start_seconds: string;
  duration_seconds: string;
  path: string;
  size_bytes: string;
  external_ref: string;
}

export interface SubmissionRow {
  id: string;
  clip_id: string;
  attempt: number;
  external_ref: string;
  claru_id: string | null;
  state: string;
}

/** Claru states after which there is nothing more to send for that clip. */
const SENT = ['processing', 'in_review', 'approved', 'rejected'];

type Answer = Record<string, unknown> & {
  id?: string;
  state?: string;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  seal?: { at?: string };
  parts?: Array<{ partId: string; fileType: string; uploadState: string; upload?: Upload }>;
};
interface Upload {
  kind: 'put' | 'multipart';
  url?: string;
  headers?: Record<string, string>;
  partSizeBytes?: number;
  parts?: Array<{ partNumber: number; url: string }>;
}

/**
 * The declaration Claru gets for one clip (claru-integration.md, "What you declare
 * with each clip"): the recording's declaration, with
 *   collectorId     = the uploader (decided 2026-10-25),
 *   recordedAt      = recording start + where this clip starts in it,
 *   durationSeconds = measured from the clip file, never typed.
 */
export function buildDeclared(rec: RecordingRow, clip: { start_seconds: string; duration_seconds: string }): Record<string, unknown> {
  const start = rec.recorded_at!.getTime() + Math.round(Number(clip.start_seconds) * 1000);
  return {
    categoryCode: rec.category_code,
    country: rec.country,
    collectorId: rec.uploader_username,
    siteId: rec.site_id,
    device: rec.device,
    mount: rec.mount,
    recordedAt: new Date(start).toISOString(),
    durationSeconds: Math.round(Number(clip.duration_seconds) * 1000) / 1000,
    consent: rec.consent,
    ...(rec.batch_ref ? { batchRef: rec.batch_ref } : {}),
  };
}

/** The attempt now in force for each clip (highest attempt number). */
export async function currentSubmissions(db: pg.Pool | pg.PoolClient, recordingId: string): Promise<Map<string, SubmissionRow>> {
  const r = await db.query<SubmissionRow>(
    `SELECT DISTINCT ON (s.clip_id) s.id, s.clip_id, s.attempt, s.external_ref, s.claru_id, s.state
       FROM submissions s JOIN clips c ON c.id = s.clip_id
      WHERE c.recording_id = $1
      ORDER BY s.clip_id, s.attempt DESC`,
    [recordingId],
  );
  return new Map(r.rows.map((s) => [s.clip_id, s]));
}

/** True when a clip of this recording is with Claru (sealed) or being sent: the declaration and the clips are then frozen. */
export async function deliveryStarted(db: pg.Pool, recordingId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM submissions s JOIN clips c ON c.id = s.clip_id
      WHERE c.recording_id = $1 AND s.state = ANY($2::text[])
     UNION ALL
     SELECT 1 FROM jobs WHERE recording_id = $1 AND kind = 'deliver' AND state = 'running'
     LIMIT 1`,
    [recordingId, [...SENT, 'draft']],
  );
  return !!r.rowCount;
}

/**
 * Queues delivery when a recording is ready: received, checks passed, clips cut,
 * declared with all four consents, and some clip not yet with Claru (and not
 * refused — a refusal waits for "Retry delivery").
 */
export async function queueDeliveryIfReady(db: pg.Pool, recordingId: string): Promise<boolean> {
  const rec = await findRecordingById(db, recordingId);
  if (!rec || rec.transfer_status !== 'received' || !['passed', 'warned'].includes(rec.check_status ?? '') || rec.split_status !== 'done') return false;
  if (!rec.declared_at || !rec.recorded_at || !consentComplete(rec.consent)) return false;
  const clips = await db.query<{ id: string }>('SELECT id FROM clips WHERE recording_id = $1', [recordingId]);
  if (!clips.rowCount) return false;
  const subs = await currentSubmissions(db, recordingId);
  const todo = clips.rows.some((c) => {
    const s = subs.get(c.id);
    return !s || s.state === 'pending' || s.state === 'draft' || s.state === 'expired';
  });
  if (todo) await enqueue(db, 'deliver', recordingId, 8);
  return todo;
}

async function ensureSubmission(db: pg.Pool, clip: ClipRow, current: SubmissionRow | undefined): Promise<SubmissionRow> {
  if (current) return current;
  const r = await db.query<SubmissionRow>(
    `INSERT INTO submissions (clip_id, attempt, external_ref) VALUES ($1, 1, $2)
     ON CONFLICT (clip_id, attempt) DO UPDATE SET updated_at = now()
     RETURNING id, clip_id, attempt, external_ref, claru_id, state`,
    [clip.id, clip.external_ref],
  );
  return r.rows[0]!;
}

async function saveRefusal(ctx: DeliveryCtx, sub: SubmissionRow, a: Answer, stage: 'create' | 'seal', draft: boolean): Promise<void> {
  const refusal = {
    code: a.code ?? 'UNKNOWN',
    message: a.message ?? '',
    remedy: (a.details?.remedy as string | undefined) ?? '',
    refusals: a.details?.refusals ?? undefined,
    stage,
    at: new Date().toISOString(),
  };
  await ctx.db.query(
    `UPDATE submissions SET state = $2, refusal = $3::jsonb, last_error = NULL, updated_at = now() WHERE id = $1`,
    [sub.id, draft ? 'draft' : 'refused', JSON.stringify(refusal)],
  );
  ctx.logger.warn({ externalRef: sub.external_ref, code: refusal.code, stage }, 'Claru refused the clip');
  if (refusal.code === 'CATEGORY_UNKNOWN' || refusal.code === 'CATEGORY_DISABLED') await ctx.refreshProject?.().catch(() => undefined);
}

async function readSlice(path: string, start: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Step 3 + 4 for one file: follow the upload shape Claru chose, then complete. */
async function uploadAndComplete(ctx: DeliveryCtx, sub: SubmissionRow, claruId: string, part: { partId: string; upload?: Upload }, clip: ClipRow): Promise<Answer> {
  const up = part.upload;
  if (!up) throw new Error(`Claru gave no upload instructions for ${sub.external_ref}`);
  let completeBody: Record<string, unknown> = {};
  if (up.kind === 'put') {
    const data = await readSlice(clip.path, 0, Number(clip.size_bytes));
    // Every header exactly as given (x-amz-meta-source is signed; content-type sets how it plays).
    await ctx.claru.putBytes(up.url!, data, up.headers ?? {}, 'whole file', sub.external_ref);
  } else {
    const size = up.partSizeBytes!;
    const slots = [...(up.parts ?? [])];
    const done: Array<{ partNumber: number; etag: string }> = [];
    const worker = async () => {
      for (let slot = slots.shift(); slot; slot = slots.shift()) {
        const data = await readSlice(clip.path, (slot.partNumber - 1) * size, size);
        const etag = await ctx.claru.putBytes(slot.url, data, {}, `part ${slot.partNumber}/${up.parts!.length}`, sub.external_ref);
        if (!etag) throw new Error(`storage gave no ETag for part ${slot.partNumber}`);
        done.push({ partNumber: slot.partNumber, etag });
      }
    };
    // Three slices at a time: 3 × 64 MiB in memory at most.
    await Promise.all([worker(), worker(), worker()]);
    completeBody = { parts: done.sort((a, b) => a.partNumber - b.partNumber) };
  }
  const c = await ctx.claru.call<Answer>('POST', `/supplier/submissions/${claruId}/parts/${part.partId}/complete`, completeBody, sub.external_ref);
  if (c.status === 422) {
    // PART_SIZE_MISMATCH: the bytes stay; create again with the same externalRef and upload again.
    await saveRefusal(ctx, sub, c.body, 'create', true);
    throw new Error(`complete refused (${c.body.code}); will create again and re-upload`);
  }
  if (c.status !== 200) throw new Error(`complete answered ${c.status}`);
  return c.body;
}

/** Steps 2–5 for one clip. Safe to repeat: the externalRef makes every repeat the same submission. */
async function deliverClip(ctx: DeliveryCtx, rec: RecordingRow, clip: ClipRow, sub: SubmissionRow): Promise<void> {
  const { db, claru } = ctx;
  const declared = buildDeclared(rec, clip);
  const create = await claru.call<Answer>(
    'POST',
    '/supplier/submissions',
    {
      projectId: claru.projectId,
      externalRef: sub.external_ref,
      contractVersion: claru.contractVersion,
      declared,
      parts: [{ fileType: 'video', fileName: `${sub.external_ref}.mp4`, byteSize: Number(clip.size_bytes) }],
    },
    sub.external_ref,
  );
  if (create.status === 403) throw new TeamProblem(`${create.body.code ?? 'forbidden'}: ${(create.body.details?.remedy as string) ?? create.body.message ?? ''}`);
  if (create.status === 422) return saveRefusal(ctx, sub, create.body, 'create', false);
  if (create.status !== 200 || !create.body.id) throw new Error(`create answered ${create.status}: ${create.body.message ?? ''}`);

  // Branch on `state` in the body, never on the status code.
  const state = create.body.state ?? 'draft';
  await db.query(
    `UPDATE submissions SET claru_id = $2, state = $3, declared = $4::jsonb, last_error = NULL, updated_at = now() WHERE id = $1`,
    [sub.id, create.body.id, state, JSON.stringify(declared)],
  );
  if (state !== 'draft') return; // already sealed earlier (a replay): the poller follows it from here

  for (const part of create.body.parts ?? []) {
    if (part.uploadState === 'uploaded') continue; // landed on an earlier run
    await uploadAndComplete(ctx, sub, create.body.id, part, clip);
  }

  const seal = await claru.call<Answer>('POST', `/supplier/submissions/${create.body.id}/seal`, undefined, sub.external_ref);
  if (seal.status === 403) throw new TeamProblem(`${seal.body.code ?? 'forbidden'}: ${(seal.body.details?.remedy as string) ?? ''}`);
  if (seal.status === 422) {
    const leavesDraft = ['PART_NOT_UPLOADED', 'PART_MISSING', 'PART_SIZE_MISMATCH'].includes(seal.body.code ?? '');
    await saveRefusal(ctx, sub, seal.body, 'seal', leavesDraft);
    if (leavesDraft) throw new Error(`seal refused (${seal.body.code}); will upload again`);
    return;
  }
  if (seal.status !== 200) throw new Error(`seal answered ${seal.status}: ${seal.body.message ?? ''}`);
  await db.query(
    `UPDATE submissions SET state = $2, seal = $3::jsonb, sealed_at = $4, refusal = NULL, last_error = NULL, updated_at = now() WHERE id = $1`,
    [sub.id, seal.body.state ?? 'processing', JSON.stringify(seal.body.seal ?? {}), seal.body.seal?.at ?? new Date().toISOString()],
  );
  ctx.logger.info({ externalRef: sub.external_ref, state: seal.body.state }, 'clip sealed at Claru');
}

/** Start-up: recordings that became ready while no delivery code existed (declared before L4), or whose job was lost. */
export async function queueReadyDeliveries(db: pg.Pool): Promise<number> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM recordings WHERE transfer_status = 'received' AND split_status = 'done' AND declared_at IS NOT NULL
        AND check_status IN ('passed', 'warned')`,
  );
  let n = 0;
  for (const { id } of r.rows) if (await queueDeliveryIfReady(db, id)) n++;
  return n;
}

/** The "deliver" job: every clip of one recording that is not with Claru yet, in order. */
export async function runDeliver(ctx: DeliveryCtx, job: JobRow): Promise<void> {
  const { db } = ctx;
  const rec = await findRecordingById(db, job.recording_id);
  if (!rec || rec.transfer_status !== 'received' || !rec.declared_at || !consentComplete(rec.consent)) return;
  const clips = await db.query<ClipRow>(
    `SELECT id, seq, start_seconds, duration_seconds, path, size_bytes, external_ref FROM clips WHERE recording_id = $1 ORDER BY seq`,
    [rec.id],
  );
  const subs = await currentSubmissions(db, rec.id);
  let failure: Error | null = null;
  for (const clip of clips.rows) {
    const sub = await ensureSubmission(db, clip, subs.get(clip.id));
    if (SENT.includes(sub.state) || sub.state === 'refused') continue;
    try {
      await deliverClip(ctx, rec, clip, sub);
    } catch (err) {
      await db.query(`UPDATE submissions SET last_error = $2, updated_at = now() WHERE id = $1`, [sub.id, (err as Error).message.slice(0, 500)]);
      if (err instanceof TeamProblem) throw err;
      failure ??= err as Error; // carry on with the other clips; the job is retried for this one
    }
  }
  if (failure) throw failure;
}
