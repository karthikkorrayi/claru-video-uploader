import { Router } from 'express';
import { ClaruUnavailableError } from '../claru/project.js';
import type { UploadContext } from '../uploads/context.js';

/** What the declaration form needs from Claru: categories and clip rules. Any signed-in user. */
export function claruRoutes(ctx: Pick<UploadContext, 'claruProject'>): Router {
  const router = Router();
  router.get('/project', async (_req, res) => {
    try {
      res.json({ project: await ctx.claruProject() });
    } catch (err) {
      if (!(err instanceof ClaruUnavailableError)) throw err;
      res.status(503).json({ error: 'claru_unavailable', message: err.message });
    }
  });
  return router;
}
