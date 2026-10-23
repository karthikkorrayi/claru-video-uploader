import type { AuthUser } from './auth/sessions.js';

export interface Scope {
  /** SQL condition to AND into a WHERE clause. */
  sql: string;
  params: unknown[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * The one place that decides which rows a user may see.
 *
 * Every query for records that belong to someone (recordings, clips, backups,
 * notes) MUST include ownerScope(user, column) in its WHERE clause:
 * admins see every row; a consultant sees only rows whose owner column is their
 * own id. Placeholders start at $firstParam so the scope can follow other params.
 */
export function ownerScope(user: AuthUser, column: string, firstParam = 1): Scope {
  if (!IDENTIFIER.test(column)) throw new Error(`ownerScope: invalid column name "${column}"`);
  if (user.role === 'admin') return { sql: 'TRUE', params: [] };
  return { sql: `${column} = $${firstParam}`, params: [user.id] };
}
