import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CONSENT_KEYS, FINGERPRINT_PATTERN, TRANSFER_STATUSES, type ConsentKey, type RecordingView } from '@cvu/shared';
import { audit } from '../audit.js';
import { ClaruUnavailableError } from '../claru/project.js';
import { currentSubmissions, deliveryStarted, queueDeliveryIfReady } from '../delivery.js';
import { cancelJobs, enqueue } from '../jobs.js';
import {
  bytesStillExpected,
  clipsFor,
  consentComplete,
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

const consentSchema = z.object(Object.fromEntries(CONSENT_KEYS.map((k) => [k, z.boolean()])) as Record<ConsentKey, z.ZodBoolean>);

/** claru-integration.md, "What you declare with each clip". collectorId is always the uploader. */
const declarationBody = z.object({
  shared: z.object({
    categoryCode: z.string().trim().min(1).max(64),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
    siteId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    device: z.string().trim().min(1).max(80),
    mount: z.string().trim().min(1).max(40),
  }),
  items: z
    .array(z.object({ id: z.string().uuid(), recordedAt: z.string().datetime({ offset: true }), consent: consentSchema }))
    .min(1)
    .max(50),
});

const EARLIEST_RECORDING = Date.parse('2020-01-01T00:00:00Z');

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
  const views = async (rows: RecordingRow[]): Promise<RecordingView[]> => {
    const clips = await clipsFor(db, rows.map((r) => r.id));
    return Promise.all(rows.map((r) => toRecordingView(r, settings.tusDir, clips.get(r.id) ?? [])));
  };
  const view = async (row: RecordingRow) => (await views([row]))[0]!;

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
    res.json({ recordings: await views(rows) });
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

  /**
   * The declaration Claru needs for each clip (phase L3). Shared fields are given
   * once for every recording in the request; the capture time and the four
   * consents are per recording. Re-declaring replaces the earlier answers
   * (until delivery starts, from L4). Every recording must be one this user may see.
   */
  router.post('/declaration', async (req, res) => {
    const user = req.auth!.user;
    const body = declarationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: 'invalid_input',
        message: 'Check the fields: country is two letters (IN), site id is letters, digits, dot, dash or underscore, and every recording needs a capture date and time.',
      });
      return;
    }
    const { shared, items } = body.data;
    if (new Set(items.map((i) => i.id)).size !== items.length) {
      res.status(400).json({ error: 'invalid_input', message: 'A recording appears twice.' });
      return;
    }
    const rows: RecordingRow[] = [];
    for (const item of items) {
      const row = await findRecordingForUser(db, user, item.id);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.transfer_status !== 'received') {
        res.status(409).json({ error: 'wrong_state', message: `${row.original_filename} has not finished uploading.` });
        return;
      }
      if (await deliveryStarted(db, row.id)) {
        res.status(409).json({
          error: 'wrong_state',
          message: `${row.original_filename} is already with Claru, so its declaration can no longer change.`,
        });
        return;
      }
      const at = Date.parse(item.recordedAt);
      if (at > Date.now() + 10 * 60_000 || at < EARLIEST_RECORDING) {
        res.status(400).json({ error: 'invalid_input', message: `${row.original_filename}: the capture time must be a real past date.` });
        return;
      }
      if (!consentComplete(item.consent)) {
        res.status(400).json({
          error: 'consent_incomplete',
          message: `${row.original_filename}: all four consent statements must be true. Do not deliver footage you cannot affirm them for.`,
        });
        return;
      }
      rows.push(row);
    }

    let categories: string[];
    try {
      categories = (await ctx.claruProject()).categories.map((c) => c.code);
    } catch (err) {
      if (!(err instanceof ClaruUnavailableError)) throw err;
      res.status(503).json({ error: 'claru_unavailable', message: `${err.message} The category cannot be checked, so nothing was saved.` });
      return;
    }
    if (categories.length > 0 && !categories.includes(shared.categoryCode)) {
      res.status(400).json({ error: 'unknown_category', message: `Category ${shared.categoryCode} is not in Claru's list for this project.` });
      return;
    }

    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const batchRef = `cvu-b-${day}-${randomBytes(3).toString('hex')}`;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        await client.query(
          `UPDATE recordings SET category_code = $2, country = $3, site_id = $4, device = $5, mount = $6,
                  recorded_at = $7, consent = $8::jsonb, batch_ref = $9, declared_at = now(), declared_by = $10, updated_at = now()
            WHERE id = $1`,
          [item.id, shared.categoryCode, shared.country, shared.siteId, shared.device, shared.mount, item.recordedAt,
            JSON.stringify(item.consent), batchRef, user.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    for (const row of rows) {
      await audit(db, {
        action: 'recording_declared',
        actorUserId: user.id,
        targetType: 'recording',
        targetId: row.id,
        ip: req.ip,
        details: { filename: row.original_filename, batchRef, categoryCode: shared.categoryCode, siteId: shared.siteId },
      });
    }
    // Declared and already checked and cut? Then it goes to Claru now.
    for (const row of rows) await queueDeliveryIfReady(db, row.id);
    const fresh = await Promise.all(rows.map((r) => findRecordingForUser(db, user, r.id)));
    res.json({ batchRef, recordings: await views(fresh.filter((r): r is RecordingRow => !!r)) });
  });

  /** Runs the checks (and cutting) again, e.g. after a failure that was not about the file. Owner or admin. */
  router.post('/:id/recheck', async (req, res) => {
    const row = await fromParam(req, res);
    if (!row) return;
    if (row.transfer_status !== 'received' || row.check_status === 'pending' || row.check_status === 'running') {
      res.status(409).json({ error: 'wrong_state', message: 'Only a received recording that is not being checked right now can be checked again.' });
      return;
    }
    if (await deliveryStarted(db, row.id)) {
      res.status(409).json({ error: 'wrong_state', message: 'Its clips are already with Claru; checking again would cut them anew.' });
      return;
    }
    await db.query(
      `UPDATE recordings SET check_status = 'pending', split_status = NULL, split_error = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await enqueue(db, 'check', row.id);
    res.json({ ok: true });
  });

  /**
   * After a REFUSAL (Claru's door said no; nothing was created): send the
   * refused clips again under the SAME externalRef — after fixing the
   * declaration, or when the cause was passing (a broken transfer).
   * Also restarts a delivery that gave up (Claru unreachable for hours).
   */
  router.post('/:id/retry-delivery', async (req, res) => {
    const row = await fromParam(req, res);
    if (!row) return;
    const subs = await currentSubmissions(db, row.id);
    const refused = [...subs.values()].filter((s) => s.state === 'refused' || s.state === 'expired');
    for (const s of refused) {
      await db.query(`UPDATE submissions SET state = 'pending', last_error = NULL, updated_at = now() WHERE id = $1`, [s.id]);
    }
    // Lost at Claru (it answered 404): create again under the same reference.
    const lost = await db.query(
      `UPDATE submissions s SET state = 'pending', claru_id = NULL, lost_at = NULL, seal = NULL, sealed_at = NULL, last_error = NULL, updated_at = now()
         FROM clips c WHERE c.id = s.clip_id AND c.recording_id = $1 AND s.lost_at IS NOT NULL
        RETURNING s.external_ref`,
      [row.id],
    );
    refused.push(...lost.rows.map((l) => ({ external_ref: l.external_ref }) as (typeof refused)[number]));
    const queued = await queueDeliveryIfReady(db, row.id);
    if (!queued) {
      res.status(409).json({ error: 'wrong_state', message: 'Nothing to send: every clip is with Claru, or the recording is not ready (checks, clips, declaration).' });
      return;
    }
    await audit(db, {
      action: 'delivery_retried',
      actorUserId: req.auth!.user.id,
      targetType: 'recording',
      targetId: row.id,
      ip: req.ip,
      details: { filename: row.original_filename, refusedClips: refused.map((s) => s.external_ref) },
    });
    res.json({ ok: true });
  });

  /**
   * After a REJECTION (a clip exists at Claru and is tied to its reference): send
   * the clip again as a NEW submission under a NEW externalRef (…-r2, -r3).
   * Rejected clips are invisible to Claru's duplicate check, so the same bytes may go.
   */
  router.post('/:id/clips/:seq/resubmit', async (req, res) => {
    const row = await fromParam(req, res);
    if (!row) return;
    const seq = Number(req.params.seq);
    const clip = await db.query<{ id: string; external_ref: string }>('SELECT id, external_ref FROM clips WHERE recording_id = $1 AND seq = $2', [row.id, seq]);
    const c = clip.rows[0];
    const current = c ? (await currentSubmissions(db, row.id)).get(c.id) : undefined;
    if (!c || !current || current.state !== 'rejected') {
      res.status(409).json({ error: 'wrong_state', message: 'Only a clip Claru rejected can be sent again as a new submission.' });
      return;
    }
    const attempt = current.attempt + 1;
    const ref = `${c.external_ref}-r${attempt}`;
    await db.query(`INSERT INTO submissions (clip_id, attempt, external_ref) VALUES ($1, $2, $3)`, [c.id, attempt, ref]);
    await queueDeliveryIfReady(db, row.id);
    await audit(db, {
      action: 'clip_resubmitted',
      actorUserId: req.auth!.user.id,
      targetType: 'recording',
      targetId: row.id,
      ip: req.ip,
      details: { filename: row.original_filename, rejected: current.external_ref, newExternalRef: ref },
    });
    res.json({ ok: true, externalRef: ref });
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
    if (await deliveryStarted(db, row.id)) {
      res.status(409).json({ error: 'wrong_state', message: 'Its clips are with Claru; the original is kept for the OneDrive backup.' });
      return;
    }
    const r = await db.query(
      `UPDATE recordings SET transfer_status = 'removed', storage_path = NULL, ended_at = now(), updated_at = now()
        WHERE id = $1 AND transfer_status = 'received'`,
      [row.id],
    );
    if (!r.rowCount) {
      res.status(409).json({ error: 'wrong_state', message: 'Only a received recording can be removed.' });
      return;
    }
    await cancelJobs(db, row.id);
    await db.query('DELETE FROM clips WHERE recording_id = $1', [row.id]);
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
