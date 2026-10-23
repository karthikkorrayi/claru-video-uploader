import { Router, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth/middleware.js';
import { dummyPasswordHash, hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { createSession, revokeSession, revokeUserSessions, SESSION_COOKIE } from '../auth/sessions.js';
import { loginBlocked } from '../auth/throttle.js';
import { findUserById, findUserByUsername, toPublicUser } from '../users.js';

export interface AuthRouteOptions {
  db: pg.Pool;
  sessionSecret: string;
  sessionHours: number;
  cookieSecure: boolean;
}

const loginBody = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(500),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(500),
  newPassword: z.string().min(1).max(500),
});

export function authRoutes(opts: AuthRouteOptions): Router {
  const { db } = opts;
  const router = Router();

  function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: opts.cookieSecure,
      path: '/',
      expires: expiresAt,
    });
  }

  router.post('/login', async (req, res) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const { username, password } = body.data;

    if (await loginBlocked(db, req.ip, username)) {
      await audit(db, { action: 'login_throttled', ip: req.ip, details: { username } });
      res.status(429).json({ error: 'too_many_attempts', retryAfterMinutes: 15 });
      return;
    }

    const user = await findUserByUsername(db, username);
    // Always run one scrypt verification, so an unknown username takes as long as a wrong password.
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok || user.disabled_at) {
      const reason = !user ? 'unknown_user' : user.disabled_at ? 'disabled' : 'wrong_password';
      await audit(db, { action: 'login_failed', actorUserId: user?.id, ip: req.ip, details: { username, reason } });
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    const session = await createSession(db, {
      userId: user.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      hours: opts.sessionHours,
      secret: opts.sessionSecret,
    });
    await audit(db, { action: 'login_succeeded', actorUserId: user.id, ip: req.ip, details: { sessionId: session.sessionId } });
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user: toPublicUser(user) });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await revokeSession(db, req.auth!.sessionId, 'logout');
    await audit(db, { action: 'logout', actorUserId: req.auth!.user.id, ip: req.ip });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    const u = req.auth!.user;
    res.json({
      user: { id: u.id, username: u.username, displayName: u.displayName, role: u.role, mustChangePassword: u.mustChangePassword },
    });
  });

  router.post('/change-password', requireAuth, async (req, res) => {
    const body = changePasswordBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const me = await findUserById(db, req.auth!.user.id);
    if (!me || !(await verifyPassword(body.data.currentPassword, me.password_hash))) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const problem =
      body.data.newPassword === body.data.currentPassword
        ? 'Choose a password different from the current one.'
        : passwordProblem(body.data.newPassword, me.username);
    if (problem) {
      res.status(400).json({ error: 'weak_password', message: problem });
      return;
    }
    await db.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [
      me.id,
      await hashPassword(body.data.newPassword),
    ]);
    const ended = await revokeUserSessions(db, me.id, 'password_changed', req.auth!.sessionId);
    await audit(db, { action: 'password_changed', actorUserId: me.id, ip: req.ip, details: { otherSessionsEnded: ended } });
    res.json({ user: { ...toPublicUser(me), mustChangePassword: false } });
  });

  return router;
}
