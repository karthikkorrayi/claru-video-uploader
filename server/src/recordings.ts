import { stat } from 'node:fs/promises';
import type pg from 'pg';
import type {
  CheckProblem,
  CheckStatus,
  ClipView,
  ConsentAnswers,
  MediaSummary,
  RecordingView,
  SplitStatus,
  TransferStatus,
} from '@cvu/shared';
import { CONSENT_KEYS } from '@cvu/shared';
import { ownerScope } from './access.js';
import type { AuthUser } from './auth/sessions.js';
import { tusFilePath } from './uploads/storage.js';

export interface RecordingRow {
  id: string;
  uploaded_by: string;
  uploader_username: string;
  uploader_display_name: string;
  original_filename: string;
  size_bytes: string; // bigint arrives as a string
  fingerprint: string;
  transfer_status: TransferStatus;
  received_bytes: string;
  failure_reason: string | null;
  storage_path: string | null;
  created_at: Date;
  transfer_started_at: Date | null;
  last_progress_at: Date | null;
  received_at: Date | null;
  check_status: CheckStatus | null;
  check_problems: CheckProblem[];
  media: MediaSummary | null;
  split_status: SplitStatus | null;
  split_error: string | null;
  category_code: string | null;
  country: string | null;
  site_id: string | null;
  device: string | null;
  mount: string | null;
  recorded_at: Date | null;
  consent: ConsentAnswers | null;
  batch_ref: string | null;
  declared_at: Date | null;
  declared_by_username: string | null;
}

interface ClipRow {
  recording_id: string;
  seq: number;
  start_seconds: string;
  duration_seconds: string;
  size_bytes: string;
  external_ref: string;
}

const SELECT = `
  SELECT r.id, r.uploaded_by, u.username AS uploader_username, u.display_name AS uploader_display_name,
         r.original_filename, r.size_bytes, r.fingerprint, r.transfer_status, r.received_bytes,
         r.failure_reason, r.storage_path, r.created_at, r.transfer_started_at, r.last_progress_at, r.received_at,
         r.check_status, r.check_problems, r.media, r.split_status, r.split_error,
         r.category_code, r.country, r.site_id, r.device, r.mount, r.recorded_at, r.consent, r.batch_ref,
         r.declared_at, d.username AS declared_by_username
    FROM recordings r JOIN users u ON u.id = r.uploaded_by LEFT JOIN users d ON d.id = r.declared_by`;

/** Internal use only (background work, tus hooks): no ownership filter. Routes use the scoped functions below. */
export async function findRecordingById(db: pg.Pool, id: string): Promise<RecordingRow | null> {
  const r = await db.query<RecordingRow>(`${SELECT} WHERE r.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** The recording if this user may see it; null otherwise (the route answers 404 either way). */
export async function findRecordingForUser(db: pg.Pool, user: AuthUser, id: string): Promise<RecordingRow | null> {
  const scope = ownerScope(user, 'r.uploaded_by', 2);
  const r = await db.query<RecordingRow>(`${SELECT} WHERE r.id = $1 AND ${scope.sql}`, [id, ...scope.params]);
  return r.rows[0] ?? null;
}

export async function listRecordingsForUser(
  db: pg.Pool,
  user: AuthUser,
  opts: { status?: TransferStatus; limit: number },
): Promise<RecordingRow[]> {
  const scope = ownerScope(user, 'r.uploaded_by', 3);
  const r = await db.query<RecordingRow>(
    `${SELECT} WHERE ($1::text IS NULL OR r.transfer_status = $1) AND ${scope.sql}
      ORDER BY r.created_at DESC LIMIT $2`,
    [opts.status ?? null, opts.limit, ...scope.params],
  );
  return r.rows;
}

/** A waiting, receiving or received recording with this fingerprint, whoever uploaded it. */
export async function findLiveByFingerprint(db: pg.Pool, fingerprint: string): Promise<RecordingRow | null> {
  const r = await db.query<RecordingRow>(
    `${SELECT} WHERE r.fingerprint = $1 AND r.transfer_status IN ('waiting', 'receiving', 'received')`,
    [fingerprint],
  );
  return r.rows[0] ?? null;
}

export async function insertRecording(
  db: pg.Pool,
  r: { uploadedBy: string; originalFilename: string; sizeBytes: number; fingerprint: string },
): Promise<RecordingRow> {
  const ins = await db.query<{ id: string }>(
    `INSERT INTO recordings (uploaded_by, original_filename, size_bytes, fingerprint)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [r.uploadedBy, r.originalFilename, r.sizeBytes, r.fingerprint],
  );
  return (await findRecordingById(db, ins.rows[0]!.id))!;
}

/** Bytes still to arrive for every upload in flight, so two big uploads cannot both count on the same free space. */
export async function bytesStillExpected(db: pg.Pool): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT coalesce(sum(size_bytes - received_bytes), 0) AS n FROM recordings WHERE transfer_status IN ('waiting', 'receiving')`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function clipsFor(db: pg.Pool, recordingIds: string[]): Promise<Map<string, ClipView[]>> {
  const out = new Map<string, ClipView[]>();
  if (!recordingIds.length) return out;
  const r = await db.query<ClipRow>(
    `SELECT recording_id, seq, start_seconds, duration_seconds, size_bytes, external_ref
       FROM clips WHERE recording_id = ANY($1::uuid[]) ORDER BY recording_id, seq`,
    [recordingIds],
  );
  for (const c of r.rows) {
    const list = out.get(c.recording_id) ?? [];
    list.push({
      seq: c.seq,
      startSeconds: Number(c.start_seconds),
      durationSeconds: Number(c.duration_seconds),
      sizeBytes: Number(c.size_bytes),
      externalRef: c.external_ref,
    });
    out.set(c.recording_id, list);
  }
  return out;
}

export function consentComplete(c: ConsentAnswers | null): boolean {
  return !!c && CONSENT_KEYS.every((k) => c[k] === true);
}

/**
 * The API view. For an upload in flight the byte count comes from the file on
 * disk, which is exact; the database copy is only refreshed every few seconds.
 */
export async function toRecordingView(row: RecordingRow, tusDir: string, clips: ClipView[] = []): Promise<RecordingView> {
  const size = Number(row.size_bytes);
  let received = Number(row.received_bytes);
  if (row.transfer_status === 'received') received = size;
  if (row.transfer_status === 'receiving') {
    received = await stat(tusFilePath(tusDir, row.id)).then(
      (s) => Math.min(s.size, size),
      () => received,
    );
  }
  const declaration =
    row.declared_at && row.recorded_at && row.category_code && row.country && row.site_id && row.device && row.mount
      ? { categoryCode: row.category_code, country: row.country, siteId: row.site_id, device: row.device, mount: row.mount }
      : null;
  const seconds =
    row.received_at && row.transfer_started_at ? (row.received_at.getTime() - row.transfer_started_at.getTime()) / 1000 : null;
  return {
    id: row.id,
    uploadedBy: { id: row.uploaded_by, username: row.uploader_username, displayName: row.uploader_display_name },
    originalFilename: row.original_filename,
    sizeBytes: size,
    transferStatus: row.transfer_status,
    receivedBytes: received,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    transferStartedAt: row.transfer_started_at?.toISOString() ?? null,
    lastProgressAt: row.last_progress_at?.toISOString() ?? null,
    receivedAt: row.received_at?.toISOString() ?? null,
    averageBytesPerSecond: seconds && seconds > 0 ? Math.round(size / seconds) : null,
    checkStatus: row.check_status,
    problems: row.check_problems ?? [],
    media: row.media,
    splitStatus: row.split_status,
    splitError: row.split_error,
    clips,
    declaration: declaration
      ? {
          ...declaration,
          recordedAt: row.recorded_at!.toISOString(),
          consent: row.consent!,
          batchRef: row.batch_ref,
          declaredAt: row.declared_at!.toISOString(),
          declaredBy: row.declared_by_username ?? '',
        }
      : null,
    readyForDelivery:
      row.transfer_status === 'received' &&
      (row.check_status === 'passed' || row.check_status === 'warned') &&
      row.split_status === 'done' &&
      clips.length > 0 &&
      !!declaration &&
      consentComplete(row.consent),
  };
}
