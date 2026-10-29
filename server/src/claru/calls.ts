import type pg from 'pg';
import type { Logger } from 'pino';
import type { ClaruCall } from './client.js';

/** Stores each Claru call for the admin's Claru page (and logs it at debug level). Never blocks the call. */
export function recordClaruCalls(db: pg.Pool, logger: Logger): (c: ClaruCall) => void {
  return (c) => {
    logger.debug({ claru: c }, 'claru call');
    db.query(
      `INSERT INTO claru_calls (method, path, status, code, ms, external_ref, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.method, c.path.slice(0, 300), c.status, c.code, c.ms, c.externalRef, c.note],
    ).catch((err: unknown) => logger.error({ err }, 'could not record a Claru call'));
  };
}

export async function pruneClaruCalls(db: pg.Pool, days = 30): Promise<void> {
  await db.query(`DELETE FROM claru_calls WHERE at < now() - make_interval(days => $1)`, [days]);
}
