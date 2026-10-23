import { basename } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { FINGERPRINT_PATTERN, TRANSFER_STATUSES, type RecordingView } from '@cvu/shared';
import { audit } from '../audit.js';
import {
  bytesStillExpected,
  findLiveByFingerprint,
  findRecordingForUser,
  insertRecording,
  listRecordingsForUser,
  toRecordingView,
  type RecordingRow,
} from '../recordings.js';
import type { UploadContext } from '../uploads/context.js';
import { freeBytes, removeRecordingDir, removeTusFiles } from '../uploads/storage.js';
import { isUniqueViolation } from '../users.js';

const GiB = 1024 ** 3;

const createBody = z.object({
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  fingerprint: z.string().regex(FINGERPRINT_PATTERN),
});

const idParam = z.string().uuid();

function gib(n: number): string {
  return `${(n / GiB).toFixed(1)} GB`;
}

/**
 * Recordings: the record of each original file. Every read and write here
 * goes through findRecordingForUser / listRecordingsForUser, which apply
 * ownerScope: consultants reach only their own rows, and anything else is a 404.
 */
export function recordingRoutes(ctx: UploadContext): Router {
  const { db, settings } = ctx;
  const router = Router();
  const view = (row: RecordingRow) => toRecordingView(row, settings.tusDir);

  async function fromParam(req: Request, res: Response): Promise<RecordingRow | null> {
    const id = idParam.safeParse(req.params.id);
    const row = id.success ? await findRecordingForUser(db, req.auth!.user, id.data) : null;
    if (!row) res.status(404).json({ error: 'not_found' });
    return row;
  }

  router.get('/', async (req, res) => {
    const status = z.enum(TRANSFER_STATUSES).optional().safeParse(req.query.status || undefined);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const rows = await listRecordingsForUser(db, req.auth!.user, { status: status.success ? status.data : undefined, limit });
    const recordings: RecordingView[] = await Promise.all(rows.map(view));
    res.json({ recordings });
  });

  router.get('/:id', async (req, res) => {
    const row = await fromParam(req, res);
    if (row) res.json({ recording: await view(row) });
  });

  /**
   * Step 1 of an upload: declare the file. Answers with the recording whose id
   * the browser then uses as the tus upload id. Declaring the same file again
   * (same fingerprint, same person, still in transit) returns the same
   * recording, which is how an upload resumes after the tab was closed.
   */
  router.post('/', async (req, res) => {
    const user = req.auth!.user;
    const body = createBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input', message: 'Send filename, sizeBytes and a 64-character fingerprint.' });
      return;
    }
    const filename = basename(body.data.filename.replaceAll('\\', '/'));
    const { sizeBytes, fingerprint } = body.data;
    if (!/\.mp4$/i.test(filename)) {
      res.status(400).json({ error: 'not_mp4', message: 'Only .mp4 files can be uploaded.' });
      return;
    }
    if (sizeBytes > settings.maxUploadBytes) {
      res.status(413).json({ error: 'too_large', message: `Files up to ${gib(settings.maxUploadBytes)} are accepted.` });
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await findLiveByFingerprint(db, fingerprint);
      if (existing) {
        const mine = existing.uploaded_by === user.id;
        if (existing.transfer_status === 'received') {
          res.status(409).json({
            error: 'already_uploaded',
            message: mine ? `You already uploaded this file (${existing.original_filename}).` : 'This file has already been uploaded by a team member.',
            ...(mine ? { recordingId: existing.id } : {}),
          });
          return;
        }
        if (!mine) {
          res.status(409).json({ error: 'duplicate_in_progress', message: 'A team member is uploading this same file right now.' });
          return;
        }
        res.json({ recording: await view(existing), resumed: true });
        return;
      }

      // Room for the original plus the clips cut from it later (L3), plus every
      // upload already in flight, plus the reserve that keeps the server healthy.
      const free = await freeBytes(settings.tusDir);
      const needed = 2 * sizeBytes + (await bytesStillExpected(db)) + settings.diskReserveBytes;
      if (free < needed) {
        ctx.logger.warn({ free, needed, sizeBytes }, 'upload refused: not enough disk space');
        res.status(507).json({
          error: 'insufficient_storage',
          message: `The server is short of space (free ${gib(free)}, needs ${gib(needed)}). Tell the admin; try again later.`,
        });
        return;
      }

      try {
        const row = await insertRecording(db, { uploadedBy: user.id, originalFilename: filename, sizeBytes, fingerprint });
        await audit(db, {
          action: 'recording_created',
          actorUserId: user.id,
          targetType: 'recording',
          targetId: row.id,
          ip: req.ip,
          details: { filename, sizeBytes },
        });
        res.status(201).json({ recording: await view(row), resumed: false });
        return;
      } catch (err) {
        // Two tabs declared the same file at the same moment: look again.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    res.status(409).json({ error: 'duplicate_in_progress', message: 'This file is already being uploaded.' });
  });

  /** Stops an upload in transit and deletes what has arrived so far. Owner or admin. */
  router.post('/:id/cancel', async (req, res) => {
    const row = await fromParam(req, res);
    if (!row) return;
    const r = await db.query(
      `UPDATE recordings SET transfer_status = 'cancelled', ended_at = now(), updated_at = now()
        WHERE id = $1 AND transfer_status IN ('waiting', 'receiving')`,
      [row.id],
    );
    if (!r.rowCount) {
      res.status(409).json({ error: 'wrong_state', message: 'Only an upload that is still in progress can be cancelled.' });
      return;
    }
    await removeTusFiles(settings.tusDir, row.id);
    await audit(db, {
      action: 'upload_cancelled',
      actorUserId: req.auth!.user.id,
      targetType: 'recording',
      targetId: row.id,
      ip: req.ip,
      details: { filename: row.original_filename, receivedBytes: Number(row.received_bytes) },
    });
    res.json({ ok: true });
  });

  /**
   * Deletes a received original from the server (for example, the wrong file
   * was uploaded). From phase L3 on this is refused once checks or delivery start.
   */
  router.post('/:id/remove', async (req, res) => {
    const row = await fromParam(req, res);
    if (!row) return;
    const r = await db.query(
      `UPDATE recordings SET transfer_status = 'removed', storage_path = NULL, ended_at = now(), updated_at = now()
        WHERE id = $1 AND transfer_status = 'received'`,
      [row.id],
    );
    if (!r.rowCount) {
      res.status(409).json({ error: 'wrong_state', message: 'Only a received recording can be removed.' });
      return;
    }
    await removeRecordingDir(settings.workDir, row.id);
    await audit(db, {
      action: 'recording_removed',
      actorUserId: req.auth!.user.id,
      targetType: 'recording',
      targetId: row.id,
      ip: req.ip,
      details: { filename: row.original_filename, sizeBytes: Number(row.size_bytes) },
    });
    res.json({ ok: true });
  });

  return router;
}
