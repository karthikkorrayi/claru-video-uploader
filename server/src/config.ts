import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Development reads the repo's .env; tests pass their own values; production
// gets real environment variables from systemd (never a file in the repo).
const envFile = resolve(repoRoot, '.env');
if (process.env.NODE_ENV !== 'test' && existsSync(envFile)) process.loadEnvFile(envFile);

const REAL_CLARU_HOST = 'app.claru.ai';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    WORK_DIR: z.string().startsWith('/', 'must be an absolute path'),
    TUS_DIR: z.string().startsWith('/', 'must be an absolute path'),
    CLARU_BASE_URL: z.string().url(),
    CLARU_API_KEY: z.string().min(1),
    CLARU_CONTRACT_VERSION: z.coerce.number().int().min(1).default(2),
    ALLOW_REAL_CLARU: z.enum(['yes', 'no']).default('no'),
    GRAPH_BASE_URL: z.string().url(),
  })
  .superRefine((c, ctx) => {
    const host = new URL(c.CLARU_BASE_URL).hostname;
    if (host === REAL_CLARU_HOST && c.NODE_ENV !== 'production' && c.ALLOW_REAL_CLARU !== 'yes') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CLARU_BASE_URL'],
        message: 'points at real Claru outside production; set ALLOW_REAL_CLARU=yes only for the controlled test',
      });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration — ${problems}`);
  }
  return parsed.data;
}

/** A copy that is safe to log: secrets replaced, passwords removed from URLs. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    ...c,
    DATABASE_URL: redactUrl(c.DATABASE_URL),
    SESSION_SECRET: '[set]',
    CLARU_API_KEY: '[set]',
    usingRealClaru: new URL(c.CLARU_BASE_URL).hostname === REAL_CLARU_HOST,
  };
}

function redactUrl(u: string): string {
  const url = new URL(u);
  if (url.password) url.password = '***';
  return url.toString();
}
