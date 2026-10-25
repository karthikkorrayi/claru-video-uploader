import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditView, ProblemView } from '@cvu/shared';
import { audit } from '../audit.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { findUserById, insertUser, isUniqueViolation, listUsers, toPublicUser, USERNAME_PATTERN, type UserRow } from '../users.js';

const createUserBody = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN),
  displayName: z.string().trim().min(1).max(80),
});

const idParam = z.string().uuid();

/** Admin-only routes. Mounted behind requireAuth + requirePasswordChanged + requireAdmin. */
export function adminRoutes(db: pg.Pool): Router {
  const router = Router();

  /** Loads the target consultant, or answers 404 / 403 and returns null. Admin accounts are not managed here. */
  async function consultantFromParam(req: Request, res: Response): Promise<UserRow | null> {
    const id = idParam.safeParse(req.params.id);
    const user = id.success ? await findUserById(db, id.data) : null;
    if (!user) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    if (user.role !== 'consultant') {
      res.status(403).json({ error: 'cannot_modify_admin' });
      return null;
    }
    return user;
  }

  router.get('/users', async (_req, res) => {
    res.json({ users: await listUsers(db) });
  });

  router.post('/users', async (req, res) => {
    const body = createUserBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: 'invalid_input',
        message: 'Username: 2–32 lowercase letters, digits, dot, dash or underscore. Display name: 1–80 characters.',
      });
      return;
    }
    const temporaryPassword = generateTemporaryPassword();
    try {
      const user = await insertUser(db, {
        username: body.data.username,
        displayName: body.data.displayName,
        role: 'consultant',
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        createdBy: req.auth!.user.id,
      });
      await audit(db, {
        action: 'user_created',
        actorUserId: req.auth!.user.id,
        targetType: 'user',
        targetId: user.id,
        ip: req.ip,
        details: { username: user.username, role: user.role },
      });
      // The temporary password is shown once, to the admin, and never stored in plain text.
      res.status(201).json({ user: toPublicUser(user), temporaryPassword });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'username_taken' });
        return;
      }
      throw err;
    }
  });

  router.post('/users/:id/disable', async (req, res) => {
    const user = await consultantFromParam(req, res);
    if (!user) return;
    await db.query('UPDATE users SET disabled_at = coalesce(disabled_at, now()), updated_at = now() WHERE id = $1', [user.id]);
    const ended = await revokeUserSessions(db, user.id, 'user_disabled');
    await audit(db, {
      action: 'user_disabled',
      actorUserId: req.auth!.user.id,
      targetType: 'user',
      targetId: user.id,
      ip: req.ip,
      details: { username: user.username, sessionsEnded: ended },
    });
    res.json({ ok: true });
  });

  router.post('/users/:id/enable', async (req, res) => {
    const user = await consultantFromParam(req, res);
    if (!user) return;
    await db.query('UPDATE users SET disabled_at = NULL, updated_at = now() WHERE id = $1', [user.id]);
    await audit(db, {
      action: 'user_enabled',
      actorUserId: req.auth!.user.id,
      targetType: 'user',
      targetId: user.id,
      ip: req.ip,
      details: { username: user.username },
    });
    res.json({ ok: true });
  });

  router.post('/users/:id/reset-password', async (req, res) => {
    const user = await consultantFromParam(req, res);
    if (!user) return;
    const temporaryPassword = generateTemporaryPassword();
    await db.query('UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1', [
      user.id,
      await hashPassword(temporaryPassword),
    ]);
    const ended = await revokeUserSessions(db, user.id, 'password_reset');
    await audit(db, {
      action: 'password_reset',
      actorUserId: req.auth!.user.id,
      targetType: 'user',
      targetId: user.id,
      ip: req.ip,
      details: { username: user.username, sessionsEnded: ended },
    });
    res.json({ temporaryPassword });
  });

  router.post('/users/:id/revoke-sessions', async (req, res) => {
    const user = await consultantFromParam(req, res);
    if (!user) return;
    const ended = await revokeUserSessions(db, user.id, 'revoked_by_admin');
    await audit(db, {
      action: 'sessions_revoked',
      actorUserId: req.auth!.user.id,
      targetType: 'user',
      targetId: user.id,
      ip: req.ip,
      details: { username: user.username, sessionsEnded: ended },
    });
    res.json({ sessionsEnded: ended });
  });

  router.get('/audit', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const r = await db.query<{
      id: string;
      at: Date;
      actor: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      ip: string | null;
      details: Record<string, unknown>;
    }>(
      `SELECT a.id, a.at, u.username AS actor, a.action, a.target_type, a.target_id, host(a.ip) AS ip, a.details
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.id DESC LIMIT $1`,
      [limit],
    );
    const entries: AuditView[] = r.rows.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      actor: e.actor,
      action: e.action,
      targetType: e.target_type,
      targetId: e.target_id,
      ip: e.ip,
      details: e.details,
    }));
    res.json({ entries });
  });

  /** The newest problems: server errors, failed background jobs, testers' browser errors. */
  router.get('/problems', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const r = await db.query<{
      id: string;
      at: Date;
      source: ProblemView['source'];
      message: string;
      detail: Record<string, unknown>;
      username: string | null;
      request_id: string | null;
      page: string | null;
    }>(
      `SELECT p.id, p.at, p.source, p.message, p.detail, u.username, p.request_id, p.page
         FROM problems p LEFT JOIN users u ON u.id = p.user_id
        ORDER BY p.id DESC LIMIT $1`,
      [limit],
    );
    const problems: ProblemView[] = r.rows.map((p) => ({
      id: p.id,
      at: p.at.toISOString(),
      source: p.source,
      message: p.message,
      detail: p.detail,
      user: p.username,
      requestId: p.request_id,
      page: p.page,
    }));
    res.json({ problems });
  });

  return router;
}
