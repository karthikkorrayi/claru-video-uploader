import type pg from 'pg';
import type { PublicUser, Role, UserSummary } from '@cvu/shared';

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  must_change_password: boolean;
  disabled_at: Date | null;
  created_at: Date;
}

export function toPublicUser(u: Pick<UserRow, 'id' | 'username' | 'display_name' | 'role' | 'must_change_password'>): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    mustChangePassword: u.must_change_password,
  };
}

export async function findUserByUsername(db: pg.Pool, username: string): Promise<UserRow | null> {
  const r = await db.query<UserRow>('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
  return r.rows[0] ?? null;
}

export async function findUserById(db: pg.Pool, id: string): Promise<UserRow | null> {
  const r = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function insertUser(
  db: pg.Pool,
  u: { username: string; displayName: string; role: Role; passwordHash: string; mustChangePassword: boolean; createdBy?: string },
): Promise<UserRow> {
  const r = await db.query<UserRow>(
    `INSERT INTO users (username, display_name, role, password_hash, must_change_password, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [u.username.toLowerCase(), u.displayName, u.role, u.passwordHash, u.mustChangePassword, u.createdBy ?? null],
  );
  return r.rows[0]!;
}

export async function listUsers(db: pg.Pool): Promise<UserSummary[]> {
  const r = await db.query<{
    id: string;
    username: string;
    display_name: string;
    role: Role;
    must_change_password: boolean;
    disabled_at: Date | null;
    created_at: Date;
    last_sign_in: Date | null;
    active_sessions: string;
  }>(
    `SELECT u.id, u.username, u.display_name, u.role, u.must_change_password, u.disabled_at, u.created_at,
            max(s.created_at) AS last_sign_in,
            count(s.id) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
       FROM users u LEFT JOIN auth_sessions s ON s.user_id = u.id
      GROUP BY u.id
      ORDER BY u.role, u.username`,
  );
  return r.rows.map((u) => ({
    ...toPublicUser(u),
    disabled: u.disabled_at !== null,
    createdAt: u.created_at.toISOString(),
    lastSignInAt: u.last_sign_in?.toISOString() ?? null,
    activeSessions: Number(u.active_sessions),
  }));
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
