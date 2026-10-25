import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';

declare module 'express-serve-static-core' {
  interface Request {
    id?: string;
  }
}

/**
 * Gives every request a short id (also sent back as X-Request-Id and shown in
 * error messages, so a tester can quote it) and logs one line when it ends.
 * Upload pieces and health checks are logged at debug level, or they would
 * drown everything else. Query strings and bodies are never logged.
 */
export function requestLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const id = randomBytes(6).toString('hex');
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    // req.path is rewritten inside routers; the original URL without its query string is the real path.
    const path = (req.originalUrl || req.url).split('?')[0] ?? '';
    res.on('finish', () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const quiet = path.startsWith('/api/uploads/') || path === '/api/healthz';
      const level = res.statusCode >= 500 ? 'error' : quiet ? 'debug' : 'info';
      logger[level]({ reqId: id, method: req.method, path, status: res.statusCode, ms, user: req.auth?.user.username }, 'request');
    });
    next();
  };
}
