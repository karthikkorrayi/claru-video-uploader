import { stat } from 'node:fs/promises';
import type pg from 'pg';
import type { RecordingView, TransferStatus } from '@cvu/shared';
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
}

const SELECT = `
  SELECT r.id, r.uploaded_by, u.username AS uploader_username, u.display_name AS uploader_display_name,
         r.original_filename, r.size_bytes, r.fingerprint, r.transfer_status, r.received_bytes,
         r.failure_reason, r.storage_path, r.created_at, r.transfer_started_at, r.last_progress_at, r.received_at
    FROM recordings r JOIN users u ON u.id = r.uploaded_by`;

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

/**
 * The API view. For an upload in flight the byte count comes from the file on
 * disk, which is exact; the database copy is only refreshed every few seconds.
 */
export async function toRecordingView(row: RecordingRow, tusDir: string): Promise<RecordingView> {
  const size = Number(row.size_bytes);
  let received = Number(row.received_bytes);
  if (row.transfer_status === 'received') received = size;
  if (row.transfer_status === 'receiving') {
    received = await stat(tusFilePath(tusDir, row.id)).then(
      (s) => Math.min(s.size, size),
      () => received,
    );
  }
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
  };
}
