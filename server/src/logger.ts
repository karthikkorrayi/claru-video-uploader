import { pino, type Logger } from 'pino';

/** JSON logs to stdout. Anything that could carry a secret is redacted. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'cvu-server' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.password',
        '*.token',
        '*.apiKey',
        '*.CLARU_API_KEY',
        '*.SESSION_SECRET',
        '*.TOKEN_ENC_KEY',
      ],
      censor: '[redacted]',
    },
  });
}
