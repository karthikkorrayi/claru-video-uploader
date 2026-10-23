import pg from 'pg';
import type { DbHealth } from '@cvu/shared';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export async function checkDb(pool: pg.Pool): Promise<DbHealth> {
  const started = Date.now();
  try {
    const r = await pool.query<{ version: string }>("select current_setting('server_version') as version");
    return { ok: true, latencyMs: Date.now() - started, version: r.rows[0]?.version };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
