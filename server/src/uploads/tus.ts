import { FileStore } from '@tus/file-store';
import { EVENTS, Server, type Upload } from '@tus/server';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UploadContext } from './context.js';
import { completeUpload } from './complete.js';

export const UPLOAD_PATH = '/api/uploads';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses the tus Upload-Metadata header: "key base64value,key2 base64value2". */
export function parseUploadMetadata(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(' ');
    if (key) out[key] = value ? Buffer.from(value, 'base64').toString('utf8') : '';
  }
  return out;
}

function deny(res: Response, status: number, message: string): false {
  // tus clients show the body text, so keep it human-readable.
  res.status(status).type('text/plain').send(`${message}\n`);
  return false;
}

/**
 * The resumable-upload endpoint (tus protocol, https://tus.io).
 *
 * The tus library only moves bytes. Who may send bytes for which recording is
 * decided here, in Express, before the library sees the request:
 *   - a recording is first created through POST /api/recordings (name, size, fingerprint);
 *   - only the consultant who created it may send its bytes — not even the admin;
 *   - the tus upload id IS the recording id, and the declared length must match.
 * Must be mounted after requireAuth + requirePasswordChanged.
 */
export function createUploadHandler(ctx: UploadContext): RequestHandler {
  const { db, logger, settings } = ctx;

  const tus = new Server({
    path: UPLOAD_PATH,
    datastore: new FileStore({ directory: settings.tusDir }),
    maxSize: settings.maxUploadBytes,
    relativeLocation: true,
    respectForwardedHeaders: false,
    postReceiveInterval: 2000,
    // The guard below has already checked recordingId belongs to this user.
    namingFunction: (_req, metadata) => metadata?.recordingId ?? '',
    onUploadCreate: async (_req, upload: Upload) => {
      const r = await db.query(
        `UPDATE recordings
            SET transfer_status = 'receiving', received_bytes = 0, last_progress_at = now(),
                transfer_started_at = coalesce(transfer_started_at, now()), updated_at = now()
          WHERE id = $1 AND transfer_status IN ('waiting', 'receiving')`,
        [upload.id],
      );
      if (!r.rowCount) throw { status_code: 404, body: 'This recording is no longer waiting for an upload.\n' };
      return {};
    },
    onUploadFinish: async (_req, upload: Upload) => {
      const result = await completeUpload(ctx, upload.id);
      if (result === 'fingerprint_mismatch') {
        // 4xx (not 409/423) so the browser stops retrying and shows the message.
        throw { status_code: 422, body: 'The file that arrived does not match the file you chose. Please upload it again.\n' };
      }
      if (result === 'not_receiving') throw { status_code: 404, body: 'This upload was cancelled.\n' };
      if (result === 'incomplete') throw { status_code: 500, body: 'Upload finished but the file is incomplete. Retrying.\n' };
      return {};
    },
  });

  tus.on(EVENTS.POST_RECEIVE, (_req, upload: Upload) => {
    db.query(
      `UPDATE recordings SET received_bytes = $2, last_progress_at = now(), updated_at = now()
        WHERE id = $1 AND transfer_status = 'receiving'`,
      [upload.id, upload.offset],
    ).catch((err: unknown) => logger.error({ err, recordingId: upload.id }, 'could not record upload progress'));
  });

  async function guard(req: Request, res: Response): Promise<boolean> {
    const user = req.auth!.user;
    const rest = req.path.slice(UPLOAD_PATH.length); // '' or '/<id>'

    if (req.method === 'OPTIONS') return true;

    if (req.method === 'POST') {
      if (rest !== '' && rest !== '/') return deny(res, 404, 'Not found');
      if (req.get('upload-defer-length') || req.get('upload-concat')) return deny(res, 400, 'Not supported');
      const id = parseUploadMetadata(req.get('upload-metadata')).recordingId ?? '';
      const r = UUID.test(id)
        ? await db.query<{ size_bytes: string }>(
            `SELECT size_bytes FROM recordings
              WHERE id = $1 AND uploaded_by = $2 AND transfer_status IN ('waiting', 'receiving')`,
            [id, user.id],
          )
        : null;
      const rec = r?.rows[0];
      if (!rec) return deny(res, 404, 'Recording not found. Add the file again.');
      if (req.get('upload-length') !== rec.size_bytes) return deny(res, 400, 'File size does not match the recording.');
      return true;
    }

    if (req.method === 'HEAD' || req.method === 'PATCH') {
      const id = rest.startsWith('/') ? rest.slice(1) : '';
      const allowed = req.method === 'HEAD' ? ['waiting', 'receiving'] : ['receiving'];
      const r = UUID.test(id)
        ? await db.query(`SELECT 1 FROM recordings WHERE id = $1 AND uploaded_by = $2 AND transfer_status = ANY($3::text[])`, [
            id,
            user.id,
            allowed,
          ])
        : null;
      if (!r?.rowCount) return deny(res, 404, 'Upload not found.');
      return true;
    }

    // DELETE (tus termination) and anything else: cancelling goes through POST /api/recordings/:id/cancel.
    return deny(res, 405, 'Not allowed. Use Cancel in the app.');
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.path !== UPLOAD_PATH && !req.path.startsWith(`${UPLOAD_PATH}/`)) {
      next();
      return;
    }
    try {
      if (await guard(req, res)) await tus.handle(req, res);
    } catch (err) {
      next(err);
    }
  };
}
