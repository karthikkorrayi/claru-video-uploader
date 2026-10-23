import type pg from 'pg';

export type AuditAction =
  | 'login_succeeded'
  | 'login_failed'
  | 'login_throttled'
  | 'logout'
  | 'password_changed'
  | 'user_created'
  | 'user_disabled'
  | 'user_enabled'
  | 'password_reset'
  | 'sessions_revoked'
  | 'admin_created'
  | 'recording_created'
  | 'upload_received'
  | 'upload_failed'
  | 'upload_cancelled'
  | 'upload_abandoned'
  | 'recording_removed';

export interface AuditEntry {
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Appends one row to audit_log. Never store passwords, tokens or keys in details. */
export async function audit(db: pg.Pool, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [e.actorUserId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.ip ?? null, JSON.stringify(e.details ?? {})],
  );
}
