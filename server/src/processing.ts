import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckProblem, CheckStatus } from '@cvu/shared';
import type { ClaruClient } from './claru/client.js';
import { queueDeliveryIfReady, runDeliver } from './delivery.js';
import { enqueue, type JobKind, type JobRow } from './jobs.js';
import { planClips } from './media/plan.js';
import { assess, checkFile, probe, readPacketIndex } from './media/probe.js';
import { cutClip, type CutClip } from './media/split.js';
import { findRecordingById } from './recordings.js';
import type { UploadContext } from './uploads/context.js';
import { originalPath, recordingDir } from './uploads/storage.js';

type Ctx = Pick<UploadContext, 'db' | 'logger' | 'settings'>;
/** With a Claru client, the "deliver" jobs can run too (phase L4). */
type FullCtx = Ctx & { claru?: ClaruClient; refreshProject?: () => Promise<unknown> };

export function clipsDir(workDir: string, recordingId: string): string {
  return join(recordingDir(workDir, recordingId), 'clips');
}

/** Claru's idempotency key for a clip. Stable: the same clip always gets the same reference. */
export function externalRef(recordingId: string, seq: number): string {
  return `cvu-${recordingId}-c${String(seq).padStart(2, '0')}`;
}

/** Step 1 after an upload: run the checks Claru will run, before anything is cut or sent. */
async function runCheck(ctx: Ctx, job: JobRow): Promise<void> {
  const { db, settings, logger } = ctx;
  const rec = await findRecordingById(db, job.recording_id);
  if (!rec || rec.transfer_status !== 'received') return;
  await db.query(`UPDATE recordings SET check_status = 'running', updated_at = now() WHERE id = $1`, [rec.id]);

  const result = await checkFile(settings.tools, originalPath(settings.workDir, rec.id), settings.clipRules);
  const status: CheckStatus = result.problems.some((p) => p.level === 'error')
    ? 'failed'
    : result.problems.some((p) => p.level === 'warn')
      ? 'warned'
      : 'passed';
  await db.query(
    `UPDATE recordings SET check_status = $2, check_problems = $3::jsonb, media = $4::jsonb, checked_at = now(),
            split_status = CASE WHEN $2 = 'failed' THEN NULL ELSE 'pending' END, split_error = NULL, updated_at = now()
      WHERE id = $1 AND transfer_status = 'received'`,
    [rec.id, status, JSON.stringify(result.problems), JSON.stringify(result.media)],
  );
  logger.info({ recordingId: rec.id, status, problems: result.problems.map((p) => p.code) }, 'recording checked');
  if (status !== 'failed') await enqueue(db, 'split', rec.id);
}

/** Step 2: cut into clips Claru accepts (even split; one clip needs no cutting). */
async function runSplit(ctx: Ctx, job: JobRow): Promise<void> {
  const { db, settings, logger } = ctx;
  const rec = await findRecordingById(db, job.recording_id);
  if (!rec || rec.transfer_status !== 'received' || !['passed', 'warned'].includes(rec.check_status ?? '')) return;
  await db.query(`UPDATE recordings SET split_status = 'running', split_error = NULL, updated_at = now() WHERE id = $1`, [rec.id]);

  const input = originalPath(settings.workDir, rec.id);
  const dir = clipsDir(settings.workDir, rec.id);
  // Start clean: a previous attempt may have stopped half-way.
  await db.query('DELETE FROM clips WHERE recording_id = $1', [rec.id]);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const [p, idx] = await Promise.all([probe(settings.tools, input), readPacketIndex(settings.tools, input)]);
  const a = assess(p, idx, settings.clipRules, null);
  const duration = Number(p.format.duration);
  const { minSeconds: min, maxSeconds: max } = settings.clipRules;
  const plan = planClips(duration, a.keyframes, min, max);
  if (!plan.ok) {
    await failSplit(ctx, rec.id, plan.reason);
    return;
  }

  const cut: CutClip[] = [];
  for (const clip of plan.clips) {
    const out = join(dir, `c${String(clip.seq).padStart(2, '0')}.mp4`);
    cut.push(await cutClip(settings.tools, input, out, clip, plan.clips.length === 1, a.telemetryStreamIndex));
  }
  const bad = cut.find((c) => !(c.duration >= min && c.duration <= max));
  if (bad) {
    await failSplit(ctx, rec.id, `Clip ${bad.seq} came out ${bad.duration.toFixed(1)} s long, outside ${min}–${max} s.`);
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Removed while we were cutting? Then throw the clips away.
    const still = await client.query(`SELECT 1 FROM recordings WHERE id = $1 AND transfer_status = 'received' FOR UPDATE`, [rec.id]);
    if (!still.rowCount) {
      await client.query('ROLLBACK');
      await rm(dir, { recursive: true, force: true });
      return;
    }
    for (const c of cut) {
      await client.query(
        `INSERT INTO clips (recording_id, seq, start_seconds, duration_seconds, path, size_bytes, external_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rec.id, c.seq, c.start, c.duration, c.path, c.sizeBytes, externalRef(rec.id, c.seq)],
      );
    }
    await client.query(`UPDATE recordings SET split_status = 'done', updated_at = now() WHERE id = $1`, [rec.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  logger.info({ recordingId: rec.id, clips: cut.map((c) => Math.round(c.duration)) }, 'recording split');
  // Already declared? Then it can go to Claru now.
  await queueDeliveryIfReady(db, rec.id);
}

async function failSplit(ctx: Ctx, id: string, reason: string): Promise<void> {
  await ctx.db.query(`UPDATE recordings SET split_status = 'failed', split_error = $2, updated_at = now() WHERE id = $1`, [id, reason]);
  ctx.logger.warn({ recordingId: id, reason }, 'split failed');
}

export function jobHandlers(ctx: FullCtx): Record<JobKind, (job: JobRow) => Promise<void>> {
  return {
    check: (job) => runCheck(ctx, job),
    split: (job) => runSplit(ctx, job),
    deliver: (job) => {
      if (!ctx.claru) throw new Error('no Claru client configured');
      return runDeliver({ db: ctx.db, logger: ctx.logger, claru: ctx.claru, refreshProject: ctx.refreshProject }, job);
    },
  };
}

/** After the last retry: say why on the recording, so it does not sit at "pending" forever. */
export function onJobGiveUp(ctx: Ctx) {
  return async (job: JobRow, error: string): Promise<void> => {
    if (job.kind === 'check') {
      const problem: CheckProblem = { code: 'CHECK_ERROR', level: 'error', message: `The checks could not run: ${error}` };
      await ctx.db.query(
        `UPDATE recordings SET check_status = 'failed', check_problems = $2::jsonb, checked_at = now(), updated_at = now() WHERE id = $1`,
        [job.recording_id, JSON.stringify([problem])],
      );
    } else if (job.kind === 'split') {
      await failSplit(ctx, job.recording_id, `Cutting failed: ${error}`);
    }
    // 'deliver': the clip's last_error already says why; "Retry delivery" starts again.
  };
}

/** Queues checks for received recordings that have never been checked (e.g. uploaded before L3). */
export async function queueUncheckedRecordings(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query<{ id: string }>(
    `UPDATE recordings SET check_status = 'pending', updated_at = now()
      WHERE transfer_status = 'received' AND check_status IS NULL RETURNING id`,
  );
  for (const { id } of r.rows) await enqueue(ctx.db, 'check', id);
  return r.rows.length;
}
