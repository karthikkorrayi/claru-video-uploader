import { audit } from '../audit.js';
import { pruneClaruCalls } from '../claru/calls.js';
import { pruneProblems } from '../problems.js';
import type { UploadContext } from './context.js';
import { completeUpload } from './complete.js';
import { removeTusFiles } from './storage.js';

export interface SweepReport {
  completed: number;
  abandoned: number;
}

/**
 * Housekeeping for uploads, run at start-up and then every few minutes:
 *  1. An upload whose last byte arrived but was never recorded (the server
 *     stopped at that moment) is completed now.
 *  2. An upload with no new bytes for `abandonAfterHours` is given up: its
 *     partial file is deleted and the consultant can start again.
 * This is only about uploads in transit; received recordings are never touched here.
 */
export async function sweepUploads(ctx: Pick<UploadContext, 'db' | 'logger' | 'settings'>, now = new Date()): Promise<SweepReport> {
  const { db, settings, logger } = ctx;
  const report: SweepReport = { completed: 0, abandoned: 0 };

  const stalled = await db.query<{ id: string }>(
    `SELECT id FROM recordings
      WHERE transfer_status = 'receiving' AND coalesce(last_progress_at, created_at) < $1::timestamptz - interval '1 minute'`,
    [now],
  );
  for (const { id } of stalled.rows) {
    if ((await completeUpload(ctx, id)) === 'received') report.completed++;
  }

  const old = await db.query<{ id: string; uploaded_by: string; original_filename: string; received_bytes: string }>(
    `UPDATE recordings
        SET transfer_status = 'abandoned', ended_at = now(), updated_at = now(),
            failure_reason = 'No data arrived for ' || $2::int || ' hours, so the partial upload was deleted.'
      WHERE transfer_status IN ('waiting', 'receiving')
        AND coalesce(last_progress_at, created_at) < $1::timestamptz - make_interval(hours => $2::int)
      RETURNING id, uploaded_by, original_filename, received_bytes`,
    [now, settings.abandonAfterHours],
  );
  for (const row of old.rows) {
    await removeTusFiles(settings.tusDir, row.id);
    await audit(db, {
      action: 'upload_abandoned',
      targetType: 'recording',
      targetId: row.id,
      details: { filename: row.original_filename, uploadedBy: row.uploaded_by, receivedBytes: Number(row.received_bytes) },
    });
    report.abandoned++;
  }

  await pruneProblems(db);
  await pruneClaruCalls(db);
  if (report.completed || report.abandoned) logger.info(report, 'upload sweep');
  return report;
}

/** Runs the sweep now and every `everyMs`. Returns a function that stops it. */
export function startUploadSweeper(ctx: Pick<UploadContext, 'db' | 'logger' | 'settings'>, everyMs = 5 * 60_000): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await sweepUploads(ctx);
    } catch (err) {
      ctx.logger.error({ err }, 'upload sweep failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
