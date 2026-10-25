import type pg from 'pg';
import type { Logger } from 'pino';

export interface Problem {
  source: 'server' | 'job' | 'browser';
  message: string;
  detail?: Record<string, unknown>;
  userId?: string | null;
  requestId?: string | null;
  page?: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Records a problem for the admin's Problems page. Never throws: a failure to
 * record must not turn into a second failure. Never put secrets in `detail`.
 */
export async function recordProblem(db: pg.Pool, logger: Logger, p: Problem): Promise<void> {
  try {
    const detail = JSON.stringify(p.detail ?? {});
    await db.query(
      `INSERT INTO problems (source, message, detail, user_id, request_id, page) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [p.source, clip(p.message || '(no message)', 1000), detail.length > 8000 ? '{"truncated":true}' : detail, p.userId ?? null, p.requestId ?? null, p.page ? clip(p.page, 300) : null],
    );
  } catch (err) {
    logger.error({ err }, 'could not record a problem');
  }
}

export async function pruneProblems(db: pg.Pool, days = 30): Promise<number> {
  const r = await db.query(`DELETE FROM problems WHERE at < now() - make_interval(days => $1)`, [days]);
  return r.rowCount ?? 0;
}
