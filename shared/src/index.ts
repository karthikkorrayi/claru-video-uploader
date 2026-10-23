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
  | 'cannot_modify_admin';
