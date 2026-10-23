import { stat } from 'node:fs/promises';
import { audit } from '../audit.js';
import { findRecordingById } from '../recordings.js';
import type { UploadContext } from './context.js';
import { fingerprintOfFile, moveToWorkDir, originalPath, removeTusFiles, tusFilePath } from './storage.js';

export type CompleteResult = 'received' | 'fingerprint_mismatch' | 'not_receiving' | 'incomplete';

export const MISMATCH_REASON =
  'The file that arrived does not match the file in your browser (fingerprint check failed). Please upload it again.';

/**
 * Turns a fully transferred upload into a received recording: confirm the
 * fingerprint, move the file into the working area, record it. Called by the
 * tus finish hook and, as a safety net, by the sweep for uploads whose last
 * byte arrived while the server was stopping.
 */
export async function completeUpload(ctx: UploadContext, id: string): Promise<CompleteResult> {
  const { db, settings } = ctx;
  const rec = await findRecordingById(db, id);
  if (!rec || rec.transfer_status !== 'receiving') return 'not_receiving';
  const size = Number(rec.size_bytes);

  // Already moved (the server stopped between the move and the database update)?
  const moved = await stat(originalPath(settings.workDir, id)).then(
    (s) => s.size === size,
    () => false,
  );
  if (!moved) {
    const partial = await stat(tusFilePath(settings.tusDir, id)).catch(() => null);
    if (!partial || partial.size !== size) return 'incomplete';
    const actual = await fingerprintOfFile(tusFilePath(settings.tusDir, id), size);
    if (actual !== rec.fingerprint) {
      await markFailed(ctx, id, MISMATCH_REASON);
      await removeTusFiles(settings.tusDir, id);
      return 'fingerprint_mismatch';
    }
    await moveToWorkDir(settings.tusDir, settings.workDir, id);
  }

  const done = await db.query<{ seconds: number | null }>(
    `UPDATE recordings
        SET transfer_status = 'received', received_bytes = size_bytes, storage_path = $2,
            received_at = now(), last_progress_at = now(), updated_at = now()
      WHERE id = $1 AND transfer_status = 'receiving'
      RETURNING extract(epoch FROM received_at - transfer_started_at)::float AS seconds`,
    [id, originalPath(settings.workDir, id)],
  );
  if (!done.rowCount) return 'not_receiving';
  await audit(db, {
    action: 'upload_received',
    actorUserId: rec.uploaded_by,
    targetType: 'recording',
    targetId: id,
    details: { filename: rec.original_filename, sizeBytes: size, seconds: Math.round(done.rows[0]?.seconds ?? 0) },
  });
  ctx.logger.info({ recordingId: id, sizeBytes: size }, 'upload received');
  return 'received';
}

export async function markFailed(ctx: UploadContext, id: string, reason: string): Promise<void> {
  const r = await ctx.db.query<{ uploaded_by: string; original_filename: string }>(
    `UPDATE recordings SET transfer_status = 'failed', failure_reason = $2, ended_at = now(), updated_at = now()
      WHERE id = $1 AND transfer_status IN ('waiting', 'receiving')
      RETURNING uploaded_by, original_filename`,
    [id, reason],
  );
  const row = r.rows[0];
  if (!row) return;
  await audit(ctx.db, {
    action: 'upload_failed',
    actorUserId: row.uploaded_by,
    targetType: 'recording',
    targetId: id,
    details: { filename: row.original_filename, reason },
  });
  ctx.logger.warn({ recordingId: id, reason }, 'upload failed');
}
