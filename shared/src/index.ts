// Types and constants shared by the server, the web app and the mocks.

export const APP_NAME = 'claru-video-uploader';

/** The two roles of the first release. */
export const ROLES = ['admin', 'consultant'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Claru's four consent statements (claru-integration.md, "The consent block").
 * All four must be true for every clip; the app never pre-ticks them.
 */
export const CONSENT_KEYS = [
  'worker_consent_obtained',
  'site_or_employer_permission_obtained',
  'required_consent_or_notice_process_followed',
  'footage_unedited',
] as const;
export type ConsentKey = (typeof CONSENT_KEYS)[number];

/** Claru submission states (claru-integration.md, "Submission states"). */
export const CLARU_STATES = ['draft', 'processing', 'in_review', 'approved', 'rejected', 'refused', 'expired'] as const;
export type ClaruState = (typeof CLARU_STATES)[number];

export interface DbHealth {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  service: string;
  uptimeSeconds: number;
  db: DbHealth;
}

/** What the API ever reveals about a user. Never includes the password hash. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

/** One row of the admin's user list. */
export interface UserSummary extends PublicUser {
  disabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  activeSessions: number;
}

/** One row of the admin's audit view. */
export interface AuditView {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

/** Error codes the API returns as { error: code }. */
export type ApiErrorCode =
  | 'not_signed_in'
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'password_change_required'
  | 'admin_only'
  | 'csrf_header_missing'
  | 'invalid_input'
  | 'weak_password'
  | 'username_taken'
  | 'not_found'
  | 'cannot_modify_admin'
  | 'not_mp4'
  | 'too_large'
  | 'insufficient_storage'
  | 'duplicate_in_progress'
  | 'already_uploaded'
  | 'wrong_state'
  | 'consent_incomplete'
  | 'unknown_category'
  | 'claru_unavailable';

/** Where the original file is in its journey from the browser to the server (phase L2). */
export const TRANSFER_STATUSES = ['waiting', 'receiving', 'received', 'abandoned', 'cancelled', 'removed', 'failed'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
/** Statuses that hold a fingerprint: a second upload of the same file is refused while one of these exists. */
export const LIVE_TRANSFER_STATUSES: readonly TransferStatus[] = ['waiting', 'receiving', 'received'];

/** One recording as the API shows it. Consultants only ever see their own. */
export interface RecordingView {
  id: string;
  uploadedBy: { id: string; username: string; displayName: string };
  originalFilename: string;
  sizeBytes: number;
  transferStatus: TransferStatus;
  receivedBytes: number;
  failureReason: string | null;
  createdAt: string;
  transferStartedAt: string | null;
  lastProgressAt: string | null;
  receivedAt: string | null;
  /** Bytes per second from first to last byte, pauses included; null until received. */
  averageBytesPerSecond: number | null;
  /** Phase L3: media checks on the received original. Null before the file is received. */
  checkStatus: CheckStatus | null;
  problems: CheckProblem[];
  media: MediaSummary | null;
  /** Phase L3: cutting into clips Claru accepts. Null until checks pass. */
  splitStatus: SplitStatus | null;
  splitError: string | null;
  clips: ClipView[];
  declaration: DeclarationView | null;
  /** Checks passed, clips cut, declaration complete: phase L4 may deliver it. */
  readyForDelivery: boolean;
}

export const CHECK_STATUSES = ['pending', 'running', 'passed', 'warned', 'failed'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type SplitStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * One finding about a recording. `error` stops delivery (Claru would refuse
 * it at seal); `warn` is delivered and shown to Claru's reviewer; `info` is a note.
 * Codes match Claru's refusal codes where the check is the same.
 */
export interface CheckProblem {
  code: string;
  level: 'error' | 'warn' | 'info';
  message: string;
}

export interface MediaSummary {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  hasAudio: boolean;
  hasTelemetry: boolean;
  maxKeyframeGapSeconds: number;
}

export interface ClipView {
  seq: number;
  startSeconds: number;
  durationSeconds: number;
  sizeBytes: number;
  externalRef: string;
}

export interface ConsentAnswers {
  worker_consent_obtained: boolean;
  site_or_employer_permission_obtained: boolean;
  required_consent_or_notice_process_followed: boolean;
  footage_unedited: boolean;
}

/** Shared fields, filled once for a batch of recordings. */
export interface SharedDeclaration {
  categoryCode: string;
  country: string;
  siteId: string;
  device: string;
  mount: string;
}

export interface DeclarationView extends SharedDeclaration {
  recordedAt: string;
  consent: ConsentAnswers;
  batchRef: string | null;
  declaredAt: string;
  declaredBy: string;
}

/** What the declaration form needs from Claru's project (GET /supplier/projects). */
export interface ClaruProjectView {
  id: string;
  name: string;
  captureAspectRatio: string;
  clipLength: { minSeconds: number; maxSeconds: number };
  categories: Array<{ code: string; name: string; parent: string | null }>;
}

/**
 * A plain-language line shown under each consent key. The key names themselves are
 * the wording Claru relies on (claru-integration.md, "The consent block"), so the
 * form always shows the key name verbatim too.
 */
export const CONSENT_TEXT: Record<ConsentKey, string> = {
  worker_consent_obtained: 'Every worker filmed gave consent.',
  site_or_employer_permission_obtained: 'The site or employer gave permission to film.',
  required_consent_or_notice_process_followed: 'The required consent or notice process was followed.',
  footage_unedited: 'The footage is unedited: one continuous recording, nothing joined or trimmed out.',
};

/**
 * A quick identity for a large file: SHA-256 over its size plus its first and
 * last 4 MiB. Cheap enough to compute in the browser for a 4 GB file, and good
 * enough to spot the same recording being uploaded twice. The server recomputes
 * it from the received file to confirm the bytes arrived intact at both ends.
 */
export const FINGERPRINT_SAMPLE_BYTES = 4 * 1024 * 1024;

/** The two byte ranges [start, end) that feed the fingerprint. They overlap for files under 8 MiB. */
export function fingerprintRanges(size: number): { head: [number, number]; tail: [number, number] } {
  return {
    head: [0, Math.min(FINGERPRINT_SAMPLE_BYTES, size)],
    tail: [Math.max(0, size - FINGERPRINT_SAMPLE_BYTES), size],
  };
}

/** Works in the browser and in Node 22 (both have Web Crypto). Returns 64 lowercase hex characters. */
export async function fingerprintFromSamples(size: number, head: Uint8Array, tail: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`cvu-fp-v1\n${size}\n`);
  const data = new Uint8Array(prefix.length + head.length + tail.length);
  data.set(prefix, 0);
  data.set(head, prefix.length);
  data.set(tail, prefix.length + head.length);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
