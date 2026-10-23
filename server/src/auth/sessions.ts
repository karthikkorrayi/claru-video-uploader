import { createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Role } from '@cvu/shared';

export const SESSION_COOKIE = 'cvu_session';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface SessionContext {
  sessionId: string;
  user: AuthUser;
}

/** 256 random bits, sent to the browser only. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores: an HMAC keyed with SESSION_SECRET, so a leaked table is useless. */
export function hashSessionToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
}

export async function createSession(
  db: pg.Pool,
  opts: { userId: string; ip?: string; userAgent?: string; hours: number; secret: string },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = newSessionToken();
  const r = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO auth_sessions (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
     RETURNING id, expires_at`,
    [opts.userId, hashSessionToken(token, opts.secret), opts.ip ?? null, opts.userAgent?.slice(0, 300) ?? null, opts.hours],
  );
  const row = r.rows[0]!;
  return { token, sessionId: row.id, expiresAt: row.expires_at };
}

/** A live session for an enabled user, or null. Refreshes last_seen_at at most once a minute. */
export async function findSession(db: pg.Pool, token: string, secret: string): Promise<SessionContext | null> {
  const r = await db.query<{
    session_id: string;
    last_seen_at: Date;
    id: string;
    username: string;
    display_name: string;
    role: Role;
    must_change_password: boolean;
  }>(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.username, u.display_name, u.role, u.must_change_password
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashSessionToken(token, secret)],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > 60_000) {
    await db.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: row.must_change_password,
    },
  };
}

export async function revokeSession(db: pg.Pool, sessionId: string, reason: string): Promise<void> {
  await db.query('UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
    reason,
  ]);
}

/** Ends every session of a user, optionally keeping one (the one making the request). Returns how many ended. */
export async function revokeUserSessions(
  db: pg.Pool,
  userId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<number> {
  const r = await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [userId, reason, exceptSessionId ?? null],
  );
  return r.rowCount ?? 0;
}
