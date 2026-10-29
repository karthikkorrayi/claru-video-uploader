import type pg from 'pg';
import type { Logger } from 'pino';
import type { ClaruClient } from './claru/client.js';
import { recordProblem } from './problems.js';

export interface ReviewSettings {
  /** Alert when Claru has not decided this long after sealing (decided: 72). */
  alertAfterHours: number;
  /** Then remind every this many hours (decided: 6). */
  remindEveryHours: number;
}

export interface ReviewCtx {
  db: pg.Pool;
  logger: Logger;
  claru: ClaruClient;
  review: ReviewSettings;
}

interface Item {
  id: string;
  state: string;
  rejection?: { code: string; type: string; reason: string; checks?: string[] };
  seal?: Record<string, unknown>;
}

const OPEN = ['processing', 'in_review'];

/**
 * Step 6, "Poll for the verdict": there is no webhook. Each round reads Claru's
 * processing and in_review lists (cheap, paged), and asks individually only about
 * our clips that left those lists — they were approved, rejected or expired.
 */
export async function pollReviews(ctx: ReviewCtx, now = new Date()): Promise<{ updated: number; alerts: AlertRound }> {
  const { db, claru } = ctx;
  const open = await db.query<{ id: string; claru_id: string; state: string; external_ref: string }>(
    `SELECT id, claru_id, state, external_ref FROM submissions WHERE state = ANY($1::text[]) AND claru_id IS NOT NULL AND lost_at IS NULL`,
    [OPEN],
  );
  let updated = 0;
  if (open.rowCount) {
    const seen = new Map<string, Item>();
    for (const state of OPEN) {
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ state, projectId: claru.projectId, limit: '200', ...(cursor ? { cursor } : {}) });
        const page = await claru.call<{ items?: Item[]; nextCursor?: string; code?: string }>('GET', `/supplier/submissions?${q}`);
        if (page.status === 400 && page.body.code === 'INVALID_CURSOR') break;
        if (page.status !== 200) throw new Error(`listing ${state} answered ${page.status}`);
        for (const it of page.body.items ?? []) seen.set(it.id, it);
        cursor = page.body.nextCursor;
      } while (cursor);
    }
    for (const s of open.rows) {
      let item = seen.get(s.claru_id);
      if (!item) {
        const one = await claru.call<Item>('GET', `/supplier/submissions/${s.claru_id}`, undefined, s.external_ref);
        if (one.status === 404) {
          // Stop asking (and alerting): it needs sending again, which the same externalRef makes safe.
          await db.query(
            `UPDATE submissions SET lost_at = $2, last_polled_at = $2, updated_at = now(),
                    last_error = 'Claru does not know this submission. Retry delivery sends it again under the same reference.'
              WHERE id = $1`,
            [s.id, now],
          );
          ctx.logger.warn({ externalRef: s.external_ref }, 'Claru does not know a submission we sealed');
          await recordProblem(ctx.db, ctx.logger, { source: 'job', message: `Claru answered 404 for ${s.external_ref}, sealed earlier. Use Retry delivery on that recording.` });
          updated++;
          continue;
        }
        if (one.status !== 200) continue;
        item = one.body;
      }
      const changed = item.state !== s.state;
      await db.query(
        `UPDATE submissions
            SET state = $2, rejection = $3::jsonb, last_polled_at = $4, updated_at = CASE WHEN $5 THEN now() ELSE updated_at END,
                decided_at = CASE WHEN $2 IN ('approved', 'rejected') AND decided_at IS NULL THEN $4 ELSE decided_at END
          WHERE id = $1`,
        [s.id, item.state, item.rejection ? JSON.stringify(item.rejection) : null, now, changed],
      );
      if (changed) {
        updated++;
        ctx.logger.info({ externalRef: s.external_ref, from: s.state, to: item.state, rejection: item.rejection?.code }, 'Claru review changed');
      }
    }
  }
  return { updated, alerts: await runReviewAlerts(ctx, now) };
}

export interface AlertRound {
  opened: number;
  reminders: number;
  resolved: number;
}

/**
 * The delayed-review alert: at 72 h after seal.at, then every 6 h, one
 * notification per interval (slot = floor((hours − 72) / 6), unique per alert),
 * until Claru approves or rejects. In-app and in the logs; no email in v1.
 * Acknowledging marks it seen; reminders continue until Claru decides.
 */
export async function runReviewAlerts(ctx: Pick<ReviewCtx, 'db' | 'logger' | 'review'>, now = new Date()): Promise<AlertRound> {
  const { db, review } = ctx;
  const round: AlertRound = { opened: 0, reminders: 0, resolved: 0 };
  const overdue = await db.query<{ id: string; external_ref: string; hours: number; uploader: string; filename: string }>(
    `SELECT s.id, s.external_ref, extract(epoch FROM ($1::timestamptz - s.sealed_at)) / 3600 AS hours,
            u.username AS uploader, r.original_filename AS filename
       FROM submissions s JOIN clips c ON c.id = s.clip_id JOIN recordings r ON r.id = c.recording_id JOIN users u ON u.id = r.uploaded_by
      WHERE s.state = ANY($2::text[]) AND s.sealed_at IS NOT NULL AND s.lost_at IS NULL
        AND s.sealed_at <= $1::timestamptz - make_interval(secs => $3)`,
    [now, OPEN, review.alertAfterHours * 3600],
  );
  for (const o of overdue.rows) {
    const slot = Math.floor((Number(o.hours) - review.alertAfterHours) / review.remindEveryHours);
    const a = await db.query<{ id: string; inserted: boolean }>(
      `INSERT INTO review_alerts (submission_id, opened_at) VALUES ($1, $2)
       ON CONFLICT (submission_id) DO UPDATE SET submission_id = EXCLUDED.submission_id
       RETURNING id, (xmax = 0) AS inserted`,
      [o.id, now],
    );
    const alert = a.rows[0]!;
    const ev = await db.query(`INSERT INTO review_alert_events (alert_id, slot, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [alert.id, slot, now]);
    if (!ev.rowCount) continue; // this interval was already notified
    await db.query(
      `UPDATE review_alerts SET last_slot = $2, notifications = notifications + 1, last_notified_at = $3 WHERE id = $1`,
      [alert.id, slot, now],
    );
    const hours = Math.floor(Number(o.hours));
    const message =
      slot === 0
        ? `Claru has not reviewed ${o.external_ref} (${o.filename}, ${o.uploader}) ${hours} hours after it was sealed.`
        : `Reminder: ${o.external_ref} still not reviewed by Claru, ${hours} hours after sealing.`;
    ctx.logger.warn({ externalRef: o.external_ref, hours, slot }, message);
    if (alert.inserted) round.opened++;
    else round.reminders++;
  }
  const resolved = await db.query(
    `UPDATE review_alerts a SET resolved_at = $1 FROM submissions s
      WHERE s.id = a.submission_id AND a.resolved_at IS NULL AND (NOT (s.state = ANY($2::text[])) OR s.lost_at IS NOT NULL)`,
    [now, OPEN],
  );
  round.resolved = resolved.rowCount ?? 0;
  return round;
}

/** Polls now and then every `everyMs`. One round at a time. Returns a stop function. */
export function startReviewPoller(ctx: ReviewCtx, everyMs: number): { stop: () => void; pollNow: () => Promise<void> } {
  let running: Promise<void> | null = null;
  const run = () => {
    running ??= pollReviews(ctx)
      .then((r) => {
        if (r.updated || r.alerts.opened || r.alerts.reminders || r.alerts.resolved) ctx.logger.info(r, 'review poll');
      })
      .catch(async (err: unknown) => {
        ctx.logger.error({ err }, 'review poll failed');
        await recordProblem(ctx.db, ctx.logger, { source: 'job', message: `Polling Claru failed: ${(err as Error).message}` });
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  void run();
  const timer = setInterval(() => void run(), everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer), pollNow: run };
}
