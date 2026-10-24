import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { UploadSettings } from './uploads/context.js';

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
    SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12),
    COOKIE_SECURE: z.enum(['auto', 'yes', 'no']).default('auto'),
    TRUST_PROXY: z.enum(['no', 'loopback']).default('no'),
    MAX_UPLOAD_GB: z.coerce.number().positive().max(64).default(8),
    DISK_RESERVE_GB: z.coerce.number().min(0).default(10),
    UPLOAD_ABANDON_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    CLARU_PROJECT_ID: z.string().uuid().default('92070f8b-acfb-44c2-8e73-1e6d9918a2b6'),
    CLIP_MIN_SECONDS: z.coerce.number().int().min(30).default(300),
    CLIP_MAX_SECONDS: z.coerce.number().int().min(60).default(1800),
    CAPTURE_ASPECT: z.enum(['4_3', '16_9']).default('4_3'),
    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  })
  .superRefine((c, ctx) => {
    if (c.CLIP_MIN_SECONDS * 2 > c.CLIP_MAX_SECONDS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CLIP_MAX_SECONDS'], message: 'must be at least twice CLIP_MIN_SECONDS' });
    }
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

/** Secure cookies need HTTPS: on in production, off on http://localhost, unless set explicitly. */
export function cookieSecure(c: Config): boolean {
  return c.COOKIE_SECURE === 'auto' ? c.NODE_ENV === 'production' : c.COOKIE_SECURE === 'yes';
}

const GiB = 1024 ** 3;

export function uploadSettings(c: Config): UploadSettings {
  return {
    tusDir: c.TUS_DIR,
    workDir: c.WORK_DIR,
    maxUploadBytes: Math.round(c.MAX_UPLOAD_GB * GiB),
    diskReserveBytes: Math.round(c.DISK_RESERVE_GB * GiB),
    abandonAfterHours: c.UPLOAD_ABANDON_HOURS,
    tools: { ffmpeg: c.FFMPEG_PATH, ffprobe: c.FFPROBE_PATH },
    clipRules: { minSeconds: c.CLIP_MIN_SECONDS, maxSeconds: c.CLIP_MAX_SECONDS, aspect: c.CAPTURE_ASPECT },
  };
}

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
