import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { ClaruCallView, ClaruOverview, DeliveryState, ReviewAlertView } from '@cvu/shared';
import { audit } from '../audit.js';
import type { ReviewSettings } from '../review.js';

export interface ClaruAdminDeps {
  db: pg.Pool;
  review: ReviewSettings;
  /** Origin of the MOCK Claru (e.g. http://127.0.0.1:4010) — null when the app talks to the real Claru. */
  mockOrigin: string | null;
  pollNow: () => Promise<void>;
}

const reviewBody = z.object({
  externalRef: z.string().min(1).max(200),
  decision: z.enum(['approve', 'reject']),
  type: z.enum(['human', 'machine']).optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(60).optional(),
  reason: z.string().max(500).optional(),
});

const faultsBody = z.object({
  refuseNextSeal: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(60).nullable().optional(),
  sealTimeouts: z.number().int().min(0).max(5).optional(),
  rateLimitNext: z.number().int().min(0).max(20).optional(),
  autoApproveSeconds: z.number().int().min(0).max(86_400).optional(),
});

/** Admin only: deliveries, overdue reviews, every call to Claru, and the mock's test controls. */
export function claruAdminRoutes(deps: ClaruAdminDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (_req, res) => {
    const counts = await db.query<{ state: DeliveryState; n: number }>(
      `SELECT state, count(*)::int AS n FROM (
         SELECT DISTINCT ON (clip_id) state, lost_at FROM submissions ORDER BY clip_id, attempt DESC) cur
       WHERE lost_at IS NULL
       GROUP BY state`,
    );
    const lost = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT DISTINCT ON (clip_id) lost_at FROM submissions ORDER BY clip_id, attempt DESC) cur
       WHERE lost_at IS NOT NULL`,
    );
    const alerts = await db.query<{
      id: string;
      external_ref: string;
      recording_id: string;
      filename: string;
      uploader: string;
      state: DeliveryState;
      sealed_at: Date;
      hours: number;
      notifications: number;
      last_notified_at: Date | null;
      acknowledged_at: Date | null;
      acknowledged_by: string | null;
      resolved_at: Date | null;
      lost: boolean;
    }>(
      `SELECT a.id, s.external_ref, r.id AS recording_id, r.original_filename AS filename, u.username AS uploader, s.state,
              s.sealed_at, extract(epoch FROM (coalesce(s.decided_at, now()) - s.sealed_at)) / 3600 AS hours,
              a.notifications, a.last_notified_at, a.acknowledged_at, ack.username AS acknowledged_by, a.resolved_at,
              s.lost_at IS NOT NULL AS lost
         FROM review_alerts a
         JOIN submissions s ON s.id = a.submission_id
         JOIN clips c ON c.id = s.clip_id
         JOIN recordings r ON r.id = c.recording_id
         JOIN users u ON u.id = r.uploaded_by
         LEFT JOIN users ack ON ack.id = a.acknowledged_by
        WHERE a.resolved_at IS NULL OR a.resolved_at > now() - interval '7 days'
        ORDER BY a.resolved_at IS NULL DESC, s.sealed_at`,
    );
    const calls = await db.query<{
      id: string;
      at: Date;
      method: string;
      path: string;
      status: number;
      code: string | null;
      ms: number;
      external_ref: string | null;
      note: string | null;
    }>(`SELECT id, at, method, path, status, code, ms, external_ref, note FROM claru_calls ORDER BY id DESC LIMIT 200`);

    const body: ClaruOverview = {
      mock: deps.mockOrigin !== null,
      alertAfterHours: deps.review.alertAfterHours,
      remindEveryHours: deps.review.remindEveryHours,
      counts: Object.fromEntries(counts.rows.map((c) => [c.state, c.n])),
      lost: lost.rows[0]?.n ?? 0,
      alerts: alerts.rows.map(
        (a): ReviewAlertView => ({
          id: a.id,
          externalRef: a.external_ref,
          recordingId: a.recording_id,
          filename: a.filename,
          uploader: a.uploader,
          state: a.state,
          sealedAt: a.sealed_at.toISOString(),
          hoursWaiting: Math.round(Number(a.hours) * 10) / 10,
          notifications: a.notifications,
          lastNotifiedAt: a.last_notified_at?.toISOString() ?? null,
          acknowledgedAt: a.acknowledged_at?.toISOString() ?? null,
          acknowledgedBy: a.acknowledged_by,
          resolvedAt: a.resolved_at?.toISOString() ?? null,
          lost: a.lost,
        }),
      ),
      calls: calls.rows.map(
        (c): ClaruCallView => ({
          id: c.id,
          at: c.at.toISOString(),
          method: c.method,
          path: c.path,
          status: c.status,
          code: c.code,
          ms: c.ms,
          externalRef: c.external_ref,
          note: c.note,
        }),
      ),
    };
    res.json(body);
  });

  /** "Seen": recorded, shown, but reminders continue until Claru decides. */
  router.post('/alerts/:id/acknowledge', async (req, res) => {
    const id = Number(req.params.id);
    const r = Number.isInteger(id)
      ? await db.query(`UPDATE review_alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL RETURNING submission_id`, [id, req.auth!.user.id])
      : null;
    if (!r?.rowCount) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await audit(db, { action: 'review_alert_acknowledged', actorUserId: req.auth!.user.id, targetType: 'review_alert', targetId: String(id), ip: req.ip });
    res.json({ ok: true });
  });

  router.post('/poll', async (_req, res) => {
    await deps.pollNow();
    res.json({ ok: true });
  });

  // ---- Test controls: only while the app talks to the MOCK Claru. ----
  router.use('/mock', (_req, res, next) => {
    if (!deps.mockOrigin) {
      res.status(404).json({ error: 'not_found', message: 'The app is connected to the real Claru: test controls are off.' });
      return;
    }
    next();
  });

  /** Make the mock approve or reject a clip, as Claru's reviewer would; then poll at once. */
  router.post('/mock/review', async (req, res) => {
    const b = reviewBody.safeParse(req.body);
    if (!b.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const sub = await db.query<{ claru_id: string | null }>('SELECT claru_id FROM submissions WHERE external_ref = $1', [b.data.externalRef]);
    const claruId = sub.rows[0]?.claru_id;
    if (!claruId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const { externalRef: _ref, ...review } = b.data;
    const r = await fetch(`${deps.mockOrigin}/__mock/submissions/${claruId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(review),
    });
    if (!r.ok) {
      res.status(409).json({ error: 'wrong_state', message: ((await r.json().catch(() => ({}))) as { message?: string }).message ?? `mock answered ${r.status}` });
      return;
    }
    await deps.pollNow();
    res.json({ ok: true });
  });

  /** Make the mock misbehave: refuse the next seal with a code, time out, rate-limit, or approve by itself. */
  router.post('/mock/faults', async (req, res) => {
    const b = faultsBody.safeParse(req.body);
    if (!b.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const { autoApproveSeconds, ...rest } = b.data;
    const payload = {
      ...rest,
      ...(autoApproveSeconds !== undefined ? { autoReview: autoApproveSeconds > 0 ? { decision: 'approve', afterSeconds: autoApproveSeconds } : null } : {}),
    };
    const r = await fetch(`${deps.mockOrigin}/__mock/faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    res.status(r.ok ? 200 : 502).json(await r.json().catch(() => ({})));
  });

  router.get('/mock/faults', async (_req, res) => {
    const r = await fetch(`${deps.mockOrigin}/__mock/submissions`);
    const body = (await r.json().catch(() => ({}))) as { faults?: unknown; autoReview?: unknown };
    res.json({ faults: body.faults ?? null, autoReview: body.autoReview ?? null });
  });

  return router;
}
