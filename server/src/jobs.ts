import type pg from 'pg';
import type { Logger } from 'pino';
import { recordProblem } from './problems.js';

export type JobKind = 'check' | 'split';

export interface JobRow {
  id: string;
  kind: JobKind;
  recording_id: string;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (job: JobRow) => Promise<void>;

/**
 * Queues a job unless one of the same kind is already queued or running for
 * this recording. Safe to call twice.
 */
export async function enqueue(db: pg.Pool | pg.PoolClient, kind: JobKind, recordingId: string): Promise<void> {
  await db.query(
    `INSERT INTO jobs (kind, recording_id) VALUES ($1, $2)
     ON CONFLICT (kind, recording_id) WHERE state IN ('queued', 'running') DO NOTHING`,
    [kind, recordingId],
  );
}

export async function cancelJobs(db: pg.Pool, recordingId: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET state = 'cancelled', finished_at = now() WHERE recording_id = $1 AND state IN ('queued', 'running')`,
    [recordingId],
  );
}

/** Takes the oldest due job, marking it running. Several servers could share the table safely (SKIP LOCKED). */
async function claim(db: pg.Pool): Promise<JobRow | null> {
  const r = await db.query<JobRow>(
    `UPDATE jobs SET state = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND run_after <= now()
                   ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, recording_id, attempts, max_attempts`,
  );
  return r.rows[0] ?? null;
}

/**
 * Runs one job. A failure is retried after 1, then 4 minutes; after the last
 * attempt the job is marked failed and `onGiveUp` records why on the recording.
 */
async function runOne(
  db: pg.Pool,
  logger: Logger,
  handlers: Record<JobKind, JobHandler>,
  job: JobRow,
  onGiveUp: (job: JobRow, error: string) => Promise<void>,
): Promise<void> {
  const started = Date.now();
  try {
    await handlers[job.kind](job);
    await db.query(`UPDATE jobs SET state = 'done', finished_at = now(), last_error = NULL WHERE id = $1 AND state = 'running'`, [job.id]);
    logger.info({ job: job.id, kind: job.kind, recordingId: job.recording_id, ms: Date.now() - started }, 'job done');
  } catch (err) {
    const message = (err as Error).message?.slice(0, 2000) ?? String(err);
    const last = job.attempts >= job.max_attempts;
    await db.query(
      `UPDATE jobs SET state = $2, last_error = $3, finished_at = CASE WHEN $2 = 'failed' THEN now() END,
              run_after = now() + make_interval(mins => $4)
        WHERE id = $1 AND state = 'running'`,
      [job.id, last ? 'failed' : 'queued', message, job.attempts * job.attempts],
    );
    logger.warn({ job: job.id, kind: job.kind, recordingId: job.recording_id, attempt: job.attempts, err: message }, 'job failed');
    await recordProblem(db, logger, {
      source: 'job',
      message: `${job.kind} failed (attempt ${job.attempts} of ${job.max_attempts}${last ? ', giving up' : ', will retry'}): ${message}`,
      detail: { job: job.id, kind: job.kind, recordingId: job.recording_id },
    });
    if (last) await onGiveUp(job, message);
  }
}

export interface JobRunner {
  /** Runs every job that is due now, one after another; for tests and start-up. */
  drain(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * One worker, one job at a time: checking and cutting a 4 GB file is disk-
 * and CPU-heavy, and doing two at once would only slow both down.
 */
export function createJobRunner(opts: {
  db: pg.Pool;
  logger: Logger;
  handlers: Record<JobKind, JobHandler>;
  onGiveUp: (job: JobRow, error: string) => Promise<void>;
  pollMs?: number;
  autoStart?: boolean;
}): JobRunner {
  const { db, logger, handlers, onGiveUp } = opts;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function drain(): Promise<number> {
    let n = 0;
    for (;;) {
      if (stopped && opts.autoStart) break;
      const job = await claim(db);
      if (!job) break;
      await runOne(db, logger, handlers, job, onGiveUp);
      n++;
    }
    return n;
  }

  async function tick() {
    if (stopped) return;
    await drain().catch((err: unknown) => logger.error({ err }, 'job runner error'));
    if (!stopped) timer = setTimeout(() => void tick(), opts.pollMs ?? 3000);
  }

  if (opts.autoStart) {
    // A server stopped mid-job left it 'running': put it back in the queue.
    void db
      .query(`UPDATE jobs SET state = 'queued', run_after = now() WHERE state = 'running'`)
      .then((r) => r.rowCount && logger.info({ requeued: r.rowCount }, 'jobs interrupted by the last stop were re-queued'))
      .then(() => tick());
  }

  return {
    drain,
    // Does not wait for a job in progress (cutting a 4 GB file can take minutes):
    // the process exits, and the job is re-queued at the next start.
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
