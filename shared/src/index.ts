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
