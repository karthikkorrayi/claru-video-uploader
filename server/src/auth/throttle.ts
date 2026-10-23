import type pg from 'pg';

export const THROTTLE_WINDOW_MINUTES = 15;
export const MAX_FAILURES_PER_IP = 5;
export const MAX_FAILURES_PER_USERNAME = 10;

/**
 * Counts failed logins in the last 15 minutes from the audit log, so the limit
 * survives restarts. Blocks an IP after 5 failures and a username after 10
 * (from any IP), until the window passes.
 */
export async function loginBlocked(db: pg.Pool, ip: string | undefined, username: string): Promise<boolean> {
  const r = await db.query<{ by_ip: string; by_user: string }>(
    `SELECT count(*) FILTER (WHERE ip = $1::inet)                 AS by_ip,
            count(*) FILTER (WHERE details->>'username' = $2)     AS by_user
       FROM audit_log
      WHERE action = 'login_failed' AND at > now() - make_interval(mins => $3)`,
    [ip ?? null, username, THROTTLE_WINDOW_MINUTES],
  );
  const row = r.rows[0]!;
  return Number(row.by_ip) >= MAX_FAILURES_PER_IP || Number(row.by_user) >= MAX_FAILURES_PER_USERNAME;
}
