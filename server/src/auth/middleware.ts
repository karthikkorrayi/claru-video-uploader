import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { findSession, SESSION_COOKIE, type SessionContext } from './sessions.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: SessionContext;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'cvu';

/**
 * Every state-changing API call must carry `X-Requested-With: cvu`. A form or
 * link on another website cannot add that header, so it cannot act as a
 * signed-in user. (The session cookie is also SameSite=Strict.)
 */
export function csrfGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || req.get(CSRF_HEADER) === CSRF_VALUE) {
      next();
      return;
    }
    res.status(403).json({ error: 'csrf_header_missing' });
  };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Attaches req.auth when the request carries a valid session cookie. Never rejects by itself. */
export function loadSession(db: pg.Pool, secret: string): RequestHandler {
  return async (req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token && token.length <= 100) {
      const ctx = await findSession(db, token, secret);
      if (ctx) req.auth = ctx;
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'not_signed_in' });
    return;
  }
  next();
}

/** A user holding a temporary password may only see who they are, change it, or sign out. */
export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.user.mustChangePassword) {
    res.status(403).json({ error: 'password_change_required' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.user.role !== 'admin') {
    res.status(403).json({ error: 'admin_only' });
    return;
  }
  next();
}
