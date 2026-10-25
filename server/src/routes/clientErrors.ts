import { Router } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import { recordProblem } from '../problems.js';

const body = z.object({
  message: z.string().min(1).max(1000),
  kind: z.enum(['error', 'unhandledrejection', 'upload', 'api']).default('error'),
  stack: z.string().max(4000).optional(),
  page: z.string().max(300).optional(),
  requestId: z.string().max(40).optional(),
});

/**
 * Errors from a tester's browser, so the admin sees what went wrong on someone
 * else's computer. Signed-in users only; at most 20 reports a minute each.
 */
export function clientErrorRoutes(db: pg.Pool, logger: Logger): Router {
  const router = Router();
  const recent = new Map<string, number[]>();

  router.post('/', async (req, res) => {
    const user = req.auth!.user;
    const now = Date.now();
    const times = (recent.get(user.id) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= 20) {
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    times.push(now);
    recent.set(user.id, times);

    const b = body.safeParse(req.body);
    if (!b.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    logger.warn({ reqId: req.id, user: user.username, kind: b.data.kind, page: b.data.page, error: b.data.message }, 'browser error');
    await recordProblem(db, logger, {
      source: 'browser',
      message: b.data.message,
      detail: { kind: b.data.kind, stack: b.data.stack, userAgent: req.get('user-agent')?.slice(0, 200) },
      userId: user.id,
      requestId: b.data.requestId ?? null,
      page: b.data.page,
    });
    res.status(204).end();
  });
  return router;
}
