#!/usr/bin/env bash
# =============================================================================
# Claru Video Uploader — Phase L0: Mac setup + project skeleton
#
# What it does (each step explained as it runs):
#   1. Checks your Mac and installs Node 22, PostgreSQL 16, FFmpeg, Git via Homebrew
#   2. Starts PostgreSQL (localhost only) and creates the claru_dev / claru_test databases
#   3. Creates the project (server, web, shared, mocks) and a Git repository
#   4. Writes .env with freshly generated secrets (never committed)
#   5. Copies the Claru integration guide into docs/ with the API key redacted
#   6. Installs npm packages, then runs typecheck, lint and tests
#   7. Starts everything briefly and checks the four health endpoints
#   8. Commits the result as "L0"
#
# Safe to re-run: it never overwrites a file you changed (it saves its own
# version beside it as <file>.new), never drops databases, and asks before
# installing anything.
#
# Usage:
#   ./claru-l0.sh [--dir ~/Projects/claru-uploader] [--guide /path/to/claru-integration.md] [--yes]
#   --dir         where to create the project (default: ~/Projects/claru-uploader)
#   --guide       path to the Claru integration guide you downloaded (optional)
#   --yes         answer "yes" to install prompts (non-interactive)
#   --skip-brew   do not use Homebrew (for Linux/CI testing only)
#   --no-smoke    skip step 7
#
# Written for macOS's built-in Bash 3.2 and BSD tools.
# =============================================================================
set -euo pipefail

PROJECT_DIR="${HOME}/Projects/claru-uploader"
GUIDE_PATH=""
ASSUME_YES="no"
SKIP_BREW="no"
RUN_SMOKE="yes"
DATA_DIR="${HOME}/claru-dev-data"
CONFLICTS=0
CREATED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) PROJECT_DIR="$2"; shift 2 ;;
    --guide) GUIDE_PATH="$2"; shift 2 ;;
    --yes) ASSUME_YES="yes"; shift ;;
    --skip-brew) SKIP_BREW="yes"; shift ;;
    --no-smoke) RUN_SMOKE="no"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 2 ;;
  esac
done

# ----------------------------------------------------------------- helpers ---
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s== %s ==%s\n' "$B" "$1" "$N"; }
info() { printf '   %s\n' "$1"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

confirm() { # confirm "question" -> 0 = yes
  if [ "$ASSUME_YES" = "yes" ]; then return 0; fi
  local ans=""
  if [ -r /dev/tty ]; then read -r -p "   ? $1 [y/N] " ans </dev/tty || true; fi
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# put_file <path>  (content on stdin)
# new file -> written; identical -> left alone; different -> <path>.new written, yours kept
put_file() {
  local path="$PROJECT_DIR/$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/cvu.XXXXXX")"
  cat > "$tmp"
  mkdir -p "$(dirname "$path")"
  if [ ! -f "$path" ]; then
    mv "$tmp" "$path"; CREATED=$((CREATED + 1))
  elif cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
  else
    mv "$tmp" "$path.new"; CONFLICTS=$((CONFLICTS + 1))
    warn "$1 differs from L0's version — kept yours, saved L0's as $1.new"
  fi
}

major_of() { echo "$1" | sed -E 's/^[^0-9]*([0-9]+).*/\1/'; }

# ------------------------------------------------------------ 1. the Mac ---
step "1/8  Checking your machine and tools"
OS="$(uname -s)"
info "OS: $OS $(uname -m), Bash ${BASH_VERSION}"
if [ "$OS" != "Darwin" ] && [ "$SKIP_BREW" = "no" ]; then
  die "This script is for macOS. (For testing elsewhere, pass --skip-brew.)"
fi

if [ "$SKIP_BREW" = "no" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew is not installed. Install it from https://brew.sh (one command), open a new terminal, then run this script again."
  fi
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
  for pkg in git node@22 postgresql@16 ffmpeg; do
    if brew list --versions "$pkg" >/dev/null 2>&1; then
      ok "$pkg already installed"
    else
      if confirm "Install $pkg with Homebrew?"; then
        brew install "$pkg"
        ok "$pkg installed"
      else
        die "$pkg is required. Re-run when ready (or pass --yes)."
      fi
    fi
  done
  # node@22 and postgresql@16 are "keg-only": put them on PATH for this run and for new terminals
  BREW_NODE="$(brew --prefix node@22)/bin"
  BREW_PG="$(brew --prefix postgresql@16)/bin"
  export PATH="$BREW_NODE:$BREW_PG:$PATH"
  ZSHRC="${HOME}/.zshrc"
  MARK="# claru-uploader: Node 22 + PostgreSQL 16 (added by claru-l0.sh)"
  if ! grep -qF "$MARK" "$ZSHRC" 2>/dev/null; then
    {
      echo ""
      echo "$MARK"
      echo "export PATH=\"$BREW_NODE:$BREW_PG:\$PATH\""
    } >> "$ZSHRC"
    ok "added Node 22 and PostgreSQL 16 to PATH in ~/.zshrc (open a new terminal to pick it up)"
  else
    ok "PATH already set in ~/.zshrc"
  fi
fi

for cmd in git node npm psql pg_isready createdb ffmpeg ffprobe curl openssl; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' not found on PATH."
done
NODE_MAJOR="$(major_of "$(node -v)")"
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22 or newer is needed (found $(node -v)). Open a new terminal so ~/.zshrc applies, then retry."
FF_MAJOR="$(major_of "$(ffmpeg -version | head -1 | awk '{print $3}')")"
[ "$FF_MAJOR" -ge 6 ] 2>/dev/null || warn "FFmpeg 6 or newer recommended (found $(ffmpeg -version | head -1 | awk '{print $3}'))"
ok "node $(node -v), npm $(npm -v), $(psql --version), ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}'), git $(git --version | awk '{print $3}')"

# ------------------------------------------------------ 2. PostgreSQL ---
step "2/8  PostgreSQL (localhost only) and databases"
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-5432}"
export PGHOST PGPORT
if ! pg_isready -q -h "$PGHOST" -p "$PGPORT"; then
  if [ "$SKIP_BREW" = "no" ]; then
    info "starting PostgreSQL 16 as a background service (starts again at login)"
    brew services start postgresql@16 >/dev/null
    i=0; while ! pg_isready -q -h "$PGHOST" -p "$PGPORT"; do i=$((i + 1)); [ $i -gt 30 ] && die "PostgreSQL did not start. Check: brew services info postgresql@16"; sleep 1; done
  else
    die "PostgreSQL is not answering on $PGHOST:$PGPORT."
  fi
fi
ok "PostgreSQL answering on $PGHOST:$PGPORT"
for db in claru_dev claru_test; do
  if [ "$(psql -d postgres -tAc "select 1 from pg_database where datname='$db'")" = "1" ]; then
    ok "database $db exists (left untouched)"
  else
    createdb "$db"; ok "database $db created"
  fi
done
PG_USER="$(psql -d postgres -tAc 'select current_user')"

# ------------------------------------------------- 3. project + git ---
step "3/8  Project folder and Git repository"
mkdir -p "$PROJECT_DIR" "$DATA_DIR/work" "$DATA_DIR/tus"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
info "project:   $PROJECT_DIR"
info "dev data:  $DATA_DIR (holding area for test videos; outside the repo)"
if [ ! -d "$PROJECT_DIR/.git" ]; then
  git -C "$PROJECT_DIR" init -q
  git -C "$PROJECT_DIR" symbolic-ref HEAD refs/heads/main
  ok "git repository created (branch main)"
else
  ok "git repository already exists"
fi

# ------------------------------------------------------- 4. the files ---
step "4/8  Writing project files"

put_file .gitignore <<'CVU_EOF'
# dependencies and build output
node_modules/
dist/
coverage/
*.tsbuildinfo
# secrets — never commit
.env
.env.*
!.env.example
# local data, logs, OS junk
*.log
.DS_Store
# files a later phase script could not apply because you changed them
*.new
CVU_EOF

put_file .nvmrc <<'CVU_EOF'
22
CVU_EOF

put_file .editorconfig <<'CVU_EOF'
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
CVU_EOF

put_file package.json <<'CVU_EOF'
{
  "name": "claru-video-uploader",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "workspaces": ["shared", "server", "mocks", "web"],
  "scripts": {
    "dev": "concurrently -k -n server,web,claru,graph -c blue,green,magenta,cyan \"npm run dev -w @cvu/server\" \"npm run dev -w @cvu/web\" \"npm run dev:claru -w @cvu/mocks\" \"npm run dev:graph -w @cvu/mocks\"",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "eslint .",
    "test": "npm run test --workspaces --if-present",
    "check": "npm run typecheck && npm run lint && npm test"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@types/node": "^22.10.5",
    "concurrently": "^9.1.2",
    "eslint": "^9.17.0",
    "globals": "^15.14.0",
    "tsx": "^4.19.2",
    "typescript": "~5.7.2",
    "typescript-eslint": "^8.19.1",
    "vite": "^6.0.7",
    "vitest": "^3.0.5"
  }
}
CVU_EOF

put_file tsconfig.base.json <<'CVU_EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": false,
    "noEmit": true
  }
}
CVU_EOF

put_file eslint.config.mjs <<'CVU_EOF'
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.new'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);
CVU_EOF

put_file .env.example <<'CVU_EOF'
# Copy to .env (the L0 script does this and fills in the secrets). Never commit .env.
NODE_ENV=development
HOST=127.0.0.1
PORT=8080
LOG_LEVEL=info

# PostgreSQL (Homebrew, localhost only)
DATABASE_URL=postgresql://localhost:5432/claru_dev
TEST_DATABASE_URL=postgresql://localhost:5432/claru_test

# At least 32 random characters: openssl rand -base64 48
SESSION_SECRET=

# Holding area for uploads in transit (absolute paths, outside the repo)
WORK_DIR=
TUS_DIR=

# Claru: the local MOCK during development. Real Claru is used only in the
# controlled test (phase L7); pointing at app.claru.ai outside production
# also needs ALLOW_REAL_CLARU=yes, so it cannot happen by accident.
CLARU_BASE_URL=http://127.0.0.1:4010/api/v1
CLARU_API_KEY=mock-claru-key
CLARU_CONTRACT_VERSION=2
ALLOW_REAL_CLARU=no

# Mock servers
MOCK_CLARU_PORT=4010
MOCK_CLARU_KEY=mock-claru-key
MOCK_GRAPH_PORT=4020

# Microsoft Graph (OneDrive): the local mock until phase L5
GRAPH_BASE_URL=http://127.0.0.1:4020/v1.0
# 32 random bytes, base64: openssl rand -base64 32 (encrypts OneDrive tokens later)
TOKEN_ENC_KEY=
CVU_EOF

# ---- shared ----
put_file shared/package.json <<'CVU_EOF'
{
  "name": "@cvu/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
CVU_EOF

put_file shared/tsconfig.json <<'CVU_EOF'
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
CVU_EOF

put_file shared/src/index.ts <<'CVU_EOF'
// Types and constants shared by the server, the web app and the mocks.

export const APP_NAME = 'claru-video-uploader';

/** The two roles of the first release. */
export const ROLES = ['admin', 'consultant'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Claru's four consent statements (claru-integration.md, "The consent block").
 * All four must be true for every clip; the app never pre-ticks them.
 */
export const CONSENT_KEYS = [
  'worker_consent_obtained',
  'site_or_employer_permission_obtained',
  'required_consent_or_notice_process_followed',
  'footage_unedited',
] as const;
export type ConsentKey = (typeof CONSENT_KEYS)[number];

/** Claru submission states (claru-integration.md, "Submission states"). */
export const CLARU_STATES = ['draft', 'processing', 'in_review', 'approved', 'rejected', 'refused', 'expired'] as const;
export type ClaruState = (typeof CLARU_STATES)[number];

export interface DbHealth {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  service: string;
  uptimeSeconds: number;
  db: DbHealth;
}
CVU_EOF

put_file shared/test/index.test.ts <<'CVU_EOF'
import { describe, expect, it } from 'vitest';
import { CLARU_STATES, CONSENT_KEYS, ROLES } from '../src/index.js';

describe('shared constants', () => {
  it('has exactly the four Claru consent statements', () => {
    expect(CONSENT_KEYS).toHaveLength(4);
    expect(new Set(CONSENT_KEYS).size).toBe(4);
  });
  it('knows both roles', () => {
    expect(ROLES).toEqual(['admin', 'consultant']);
  });
  it('lists the seven Claru states', () => {
    expect(CLARU_STATES).toContain('refused');
    expect(CLARU_STATES).toContain('rejected');
    expect(CLARU_STATES).toHaveLength(7);
  });
});
CVU_EOF

# ---- server ----
put_file server/package.json <<'CVU_EOF'
{
  "name": "@cvu/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@cvu/shared": "0.0.0",
    "express": "^5.0.1",
    "pg": "^8.13.1",
    "pino": "^9.6.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/pg": "^8.11.10"
  }
}
CVU_EOF

put_file server/tsconfig.json <<'CVU_EOF'
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test", "vitest.config.ts"]
}
CVU_EOF

put_file server/vitest.config.ts <<'CVU_EOF'
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests read TEST_DATABASE_URL from the repo's .env (never the dev database).
const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: { environment: 'node', testTimeout: 15_000 },
});
CVU_EOF

put_file server/src/config.ts <<'CVU_EOF'
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
CVU_EOF

put_file server/src/logger.ts <<'CVU_EOF'
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
CVU_EOF

put_file server/src/db.ts <<'CVU_EOF'
import pg from 'pg';
import type { DbHealth } from '@cvu/shared';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export async function checkDb(pool: pg.Pool): Promise<DbHealth> {
  const started = Date.now();
  try {
    const r = await pool.query<{ version: string }>("select current_setting('server_version') as version");
    return { ok: true, latencyMs: Date.now() - started, version: r.rows[0]?.version };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
CVU_EOF

put_file server/src/app.ts <<'CVU_EOF'
import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { APP_NAME, type HealthReport } from '@cvu/shared';
import { checkDb } from './db.js';

export interface AppDeps {
  pool: pg.Pool;
  logger: Logger;
  startedAt?: number;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const startedAt = deps.startedAt ?? Date.now();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/healthz', async (_req, res) => {
    const db = await checkDb(deps.pool);
    const body: HealthReport = {
      ok: db.ok,
      service: APP_NAME,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      db,
    };
    res.status(db.ok ? 200 : 503).json(body);
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
CVU_EOF

put_file server/src/index.ts <<'CVU_EOF'
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { describeConfig, loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

for (const dir of [config.WORK_DIR, config.TUS_DIR]) mkdirSync(dir, { recursive: true });

const pool = createPool(config.DATABASE_URL);
const app = createApp({ pool, logger });

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ config: describeConfig(config) }, `server listening on http://${config.HOST}:${config.PORT}`);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal} received, shutting down`);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
CVU_EOF

put_file server/test/health.test.ts <<'CVU_EOF'
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthReport } from '@cvu/shared';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/claru_test';
const pool = createPool(dbUrl);
let server: Server;
let base = '';

beforeAll(async () => {
  const app = createApp({ pool, logger: createLogger('silent') });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await pool.end();
});

describe('GET /api/healthz', () => {
  it('reports the database as up', async () => {
    const res = await fetch(`${base}/api/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.db.version).toMatch(/^\d+/);
  });

  it('answers unknown API paths with JSON 404', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
CVU_EOF

put_file server/test/config.test.ts <<'CVU_EOF'
import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../src/config.js';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/claru_dev',
  SESSION_SECRET: 'x'.repeat(40),
  WORK_DIR: '/tmp/cvu/work',
  TUS_DIR: '/tmp/cvu/tus',
  CLARU_BASE_URL: 'http://127.0.0.1:4010/api/v1',
  CLARU_API_KEY: 'mock-claru-key',
  GRAPH_BASE_URL: 'http://127.0.0.1:4020/v1.0',
};

describe('configuration', () => {
  it('accepts a complete development config', () => {
    expect(loadConfig(valid).PORT).toBe(8080);
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('refuses real Claru outside production unless explicitly allowed', () => {
    const real = { ...valid, CLARU_BASE_URL: 'https://app.claru.ai/api/v1' };
    expect(() => loadConfig(real)).toThrow(/ALLOW_REAL_CLARU/);
    expect(loadConfig({ ...real, ALLOW_REAL_CLARU: 'yes' }).CLARU_BASE_URL).toContain('app.claru.ai');
  });

  it('never exposes secrets when logged', () => {
    const text = JSON.stringify(describeConfig(loadConfig(valid)));
    expect(text).not.toContain('secret@');
    expect(text).not.toContain('mock-claru-key');
    expect(text).not.toContain('x'.repeat(40));
  });
});
CVU_EOF

# ---- mocks ----
put_file mocks/package.json <<'CVU_EOF'
{
  "name": "@cvu/mocks",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:claru": "tsx watch src/claru-server.ts",
    "dev:graph": "tsx watch src/graph-server.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^5.0.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0"
  }
}
CVU_EOF

put_file mocks/tsconfig.json <<'CVU_EOF'
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
CVU_EOF

put_file mocks/src/env.ts <<'CVU_EOF'
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load the repo's .env for the mock servers (not used by tests). */
export function loadRepoEnv(): void {
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
CVU_EOF

put_file mocks/src/claru.ts <<'CVU_EOF'
// Mock of Claru's supplier API, built only from claru-integration.md (contract v2).
// L0 implements discovery (GET /supplier/projects) and authentication.
// L4 adds create, upload, complete, seal, poll, refusals and fault injection.
import express from 'express';

export interface MockClaruOptions {
  apiKey: string;
}

/** The project from the guide's "Your projects"; category codes are mock samples. */
export const MOCK_PROJECT = {
  id: '92070f8b-acfb-44c2-8e73-1e6d9918a2b6',
  name: 'Commercial Egocentric Evaluation (RGB Supplier Upload)',
  checkGroups: { video: 'error', imu: 'off', stereo: 'off' },
  imuExpected: false,
  captureAspectRatio: '4_3',
  expectedFiles: [
    { fileType: 'video', required: true },
    { fileType: 'inputs', required: false },
    { fileType: 'other', required: false },
  ],
  clipLength: { minSeconds: 300, maxSeconds: 1800 },
  categories: [
    { code: 'MOCK-KITCHEN-PREP', name: 'Food preparation (mock)', parent: { id: 'mock-p1', name: 'Kitchen (mock)' } },
    { code: 'MOCK-WAREHOUSE-PICK', name: 'Picking (mock)', parent: { id: 'mock-p2', name: 'Warehouse (mock)' } },
  ],
  contractVersion: 2,
} as const;

export function createMockClaru(opts: MockClaruOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/__mock/health', (_req, res) => {
    res.json({ ok: true, service: 'mock-claru' });
  });

  // Every API call carries x-api-key; a wrong or missing key is a plain 401 with no code.
  app.use('/api/v1', (req, res, next) => {
    if (req.get('x-api-key') !== opts.apiKey) {
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
      return;
    }
    next();
  });

  app.get('/api/v1/supplier/projects', (_req, res) => {
    res.json({
      team: { id: 'mock-team', name: 'Veda solutions (mock)', status: 'active' },
      contract: { version: 2, minAcceptedVersion: 1 },
      rateLimit: { requestsPerMinute: 600 },
      projects: [MOCK_PROJECT],
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ statusCode: 404, message: 'Not Found (mock: implemented in a later phase)' });
  });

  return app;
}
CVU_EOF

put_file mocks/src/claru-server.ts <<'CVU_EOF'
import { createMockClaru } from './claru.js';
import { loadRepoEnv } from './env.js';

loadRepoEnv();
const port = Number(process.env.MOCK_CLARU_PORT ?? 4010);
const apiKey = process.env.MOCK_CLARU_KEY ?? 'mock-claru-key';

createMockClaru({ apiKey }).listen(port, '127.0.0.1', () => {
  console.warn(`mock Claru on http://127.0.0.1:${port}/api/v1 (NOT the real Claru)`);
});
CVU_EOF

put_file mocks/src/graph.ts <<'CVU_EOF'
// Mock of the Microsoft Graph calls used for OneDrive backups.
// L0: health only. L5 adds upload sessions, chunk rules, resume, conflict handling.
import express from 'express';

export function createMockGraph(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/__mock/health', (_req, res) => {
    res.json({ ok: true, service: 'mock-graph' });
  });

  app.use((_req, res) => {
    res.status(501).json({ error: { code: 'notImplemented', message: 'mock Graph: implemented in phase L5' } });
  });

  return app;
}
CVU_EOF

put_file mocks/src/graph-server.ts <<'CVU_EOF'
import { loadRepoEnv } from './env.js';
import { createMockGraph } from './graph.js';

loadRepoEnv();
const port = Number(process.env.MOCK_GRAPH_PORT ?? 4020);

createMockGraph().listen(port, '127.0.0.1', () => {
  console.warn(`mock Microsoft Graph on http://127.0.0.1:${port} (NOT the real OneDrive)`);
});
CVU_EOF

put_file mocks/test/claru.test.ts <<'CVU_EOF'
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockClaru, MOCK_PROJECT } from '../src/claru.js';

interface ProjectsResponse {
  team: { status: string };
  contract: { version: number; minAcceptedVersion: number };
  rateLimit: { requestsPerMinute: number };
  projects: Array<{ id: string; clipLength: { minSeconds: number; maxSeconds: number }; checkGroups: { imu: string } }>;
}

let server: Server;
let base = '';

beforeAll(async () => {
  server = createMockClaru({ apiKey: 'test-key' }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

describe('mock Claru discovery', () => {
  it('rejects a missing key with a plain 401', async () => {
    const res = await fetch(`${base}/api/v1/supplier/projects`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ statusCode: 401, message: 'Unauthorized' });
  });

  it('lists the project from the guide with the right key', async () => {
    const res = await fetch(`${base}/api/v1/supplier/projects`, { headers: { 'x-api-key': 'test-key' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectsResponse;
    const project = body.projects[0];
    expect(body.team.status).toBe('active');
    expect(body.contract).toEqual({ version: 2, minAcceptedVersion: 1 });
    expect(body.rateLimit.requestsPerMinute).toBe(600);
    expect(project?.id).toBe(MOCK_PROJECT.id);
    expect(project?.clipLength).toEqual({ minSeconds: 300, maxSeconds: 1800 });
    expect(project?.checkGroups.imu).toBe('off');
  });
});
CVU_EOF

# ---- web ----
put_file web/package.json <<'CVU_EOF'
{
  "name": "@cvu/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@cvu/shared": "0.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.7"
  }
}
CVU_EOF

put_file web/tsconfig.json <<'CVU_EOF'
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts"]
}
CVU_EOF

put_file web/vite.config.ts <<'CVU_EOF'
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser only ever talks to this dev server; /api is passed to the Node
// server on 8080, so cookies stay same-origin (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});
CVU_EOF

put_file web/index.html <<'CVU_EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Claru Video Uploader</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
CVU_EOF

put_file web/src/main.tsx <<'CVU_EOF'
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
CVU_EOF

put_file web/src/App.tsx <<'CVU_EOF'
import { useEffect, useState } from 'react';
import type { HealthReport } from '@cvu/shared';

type State = { kind: 'loading' } | { kind: 'ok'; health: HealthReport } | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetch('/api/healthz')
      .then(async (r) => {
        const body = (await r.json()) as HealthReport;
        setState(r.ok ? { kind: 'ok', health: body } : { kind: 'error', message: body.db.error ?? `HTTP ${r.status}` });
      })
      .catch((e: unknown) => setState({ kind: 'error', message: String(e) }));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
      <h1>Claru Video Uploader</h1>
      <p>Phase L0 — project skeleton</p>
      {state.kind === 'loading' && <p>Checking the server…</p>}
      {state.kind === 'ok' && (
        <p style={{ color: '#1d7a46' }}>
          ✓ Server and database are up (PostgreSQL {state.health.db.version}, {state.health.db.latencyMs} ms)
        </p>
      )}
      {state.kind === 'error' && <p style={{ color: '#b42318' }}>✗ {state.message}</p>}
    </main>
  );
}
CVU_EOF

# ---- docs ----
put_file README.md <<'CVU_EOF'
# Claru Video Uploader

Private web app that receives MP4 recordings, delivers them to Claru through its
supplier API (contract v2), tracks Claru's review, and backs originals up to OneDrive.

## Layout

| Folder    | What it is                                                        |
| --------- | ----------------------------------------------------------------- |
| `server/` | Node 22 + Express API, background jobs (later), PostgreSQL access |
| `web/`    | React + Vite front end                                            |
| `shared/` | Types and constants used by server, web and mocks                 |
| `mocks/`  | Local stand-ins for Claru (port 4010) and Microsoft Graph (4020)  |
| `docs/`   | Claru integration guide (API key redacted) and phase notes        |

## Daily commands

```bash
npm run dev     # server :8080, web :5173, mock Claru :4010, mock Graph :4020
npm run check   # typecheck + lint + tests
```

Open http://127.0.0.1:5173.

## Rules

- `.env` holds secrets and is never committed. `.env.example` lists every setting.
- Development talks to the mocks. Real Claru needs `ALLOW_REAL_CLARU=yes` and is used
  only in the controlled test.
- Each phase is applied by a script and committed as one Git commit.
CVU_EOF

put_file docs/phases/L0.md <<'CVU_EOF'
# Phase L0 — Mac setup and project skeleton

Gate: `npm run check` passes, and `npm run dev` starts the server, the web app and
both mocks, each answering its health check:

| Service     | Health URL                                   |
| ----------- | -------------------------------------------- |
| Server + DB | http://127.0.0.1:8080/api/healthz            |
| Web         | http://127.0.0.1:5173 (shows a green tick)   |
| Mock Claru  | http://127.0.0.1:4010/__mock/health          |
| Mock Graph  | http://127.0.0.1:4020/__mock/health          |

Next: L1 — login, users and roles.
CVU_EOF

ok "$CREATED file(s) written$( [ $CONFLICTS -gt 0 ] && printf ', %s kept as yours (.new beside them)' "$CONFLICTS" )"

# ------------------------------------------------------------ 5. .env ---
step "5/8  Local secrets (.env)"
ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  ok ".env already exists — left untouched"
else
  SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  TOKEN_ENC_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  umask 077
  sed \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" \
    -e "s|^TOKEN_ENC_KEY=.*|TOKEN_ENC_KEY=${TOKEN_ENC_KEY}|" \
    -e "s|^WORK_DIR=.*|WORK_DIR=${DATA_DIR}/work|" \
    -e "s|^TUS_DIR=.*|TUS_DIR=${DATA_DIR}/tus|" \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${PG_USER}@${PGHOST}:${PGPORT}/claru_dev|" \
    -e "s|^TEST_DATABASE_URL=.*|TEST_DATABASE_URL=postgresql://${PG_USER}@${PGHOST}:${PGPORT}/claru_test|" \
    "$PROJECT_DIR/.env.example" > "$ENV_FILE"
  umask 022
  ok ".env created with new random secrets (permissions: owner only)"
fi
if git -C "$PROJECT_DIR" check-ignore -q .env; then ok ".env is ignored by Git"; else die ".env is NOT ignored by Git — stop and check .gitignore"; fi

# ------------------------------------------------- 6. Claru guide copy ---
step "6/8  Claru integration guide"
DOC_GUIDE="$PROJECT_DIR/docs/claru-integration.md"
if [ -n "$GUIDE_PATH" ]; then
  [ -f "$GUIDE_PATH" ] || die "Guide not found at $GUIDE_PATH"
  tmp="$(mktemp "${TMPDIR:-/tmp}/cvu.XXXXXX")"
  # Redact anything shaped like a Claru key (claru_ + 8 or more letters/digits).
  sed -E 's/claru_[A-Za-z0-9]{8,}/<REDACTED-CLARU-API-KEY>/g' "$GUIDE_PATH" > "$tmp"
  if grep -Eq 'claru_[A-Za-z0-9]{8,}' "$tmp"; then rm -f "$tmp"; die "Redaction failed; guide not copied."; fi
  if [ -f "$DOC_GUIDE" ] && cmp -s "$tmp" "$DOC_GUIDE"; then
    rm -f "$tmp"; ok "docs/claru-integration.md already up to date"
  else
    mv "$tmp" "$DOC_GUIDE"; ok "copied to docs/claru-integration.md with the API key redacted ($(wc -l < "$DOC_GUIDE" | tr -d ' ') lines)"
  fi
elif [ -f "$DOC_GUIDE" ]; then
  ok "docs/claru-integration.md already present"
else
  warn "No --guide given. Re-run later with --guide ~/Downloads/claru-integration.md to add it."
fi

# ------------------------------------------- 7. install + checks + smoke ---
step "7/8  Installing packages and running checks"
cd "$PROJECT_DIR"
info "npm install (first run downloads ~150 MB; a minute or two)"
npm install --no-audit --no-fund --loglevel=error
ok "packages installed"
run_check() { # run_check <label> <command...> — stops the script if the check fails
  local label="$1"; shift
  info "$label"
  if "$@"; then ok "$label passed"; else die "$label failed — see the messages above. Fix, then re-run this script."; fi
}
run_check "typecheck" npm run -s typecheck
run_check "lint" npm run -s lint
run_check "tests" npm test --silent

if [ "$RUN_SMOKE" = "yes" ]; then
  info "starting all four services for a smoke test"
  for url in http://127.0.0.1:8080/api/healthz http://127.0.0.1:5173 http://127.0.0.1:4010/__mock/health http://127.0.0.1:4020/__mock/health; do
    if curl -s -o /dev/null --max-time 1 "$url"; then
      die "Something is already answering at $url. Stop it (another 'npm run dev'?) and re-run."
    fi
  done
  LOG="$DATA_DIR/l0-smoke.log"
  set -m
  npm run dev > "$LOG" 2>&1 &
  DEV_PID=$!
  set +m
  cleanup_dev() { kill -TERM -- "-$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true; }
  trap cleanup_dev EXIT
  failed=0
  for url in http://127.0.0.1:8080/api/healthz http://127.0.0.1:5173/ http://127.0.0.1:4010/__mock/health http://127.0.0.1:4020/__mock/health; do
    i=0; code=""
    while [ $i -lt 45 ]; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)"
      [ "$code" = "200" ] && break
      i=$((i + 1)); sleep 1
    done
    if [ "$code" = "200" ]; then ok "$url → 200"; else warn "$url → ${code:-no answer}"; failed=1; fi
  done
  # The web app proxies /api to the server: same check through port 5173
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:5173/api/healthz || true)"
  if [ "$code" = "200" ]; then ok "web → server proxy works"; else warn "web proxy → ${code:-no answer}"; failed=1; fi
  cleanup_dev; trap - EXIT; sleep 1
  [ $failed -eq 0 ] || die "Smoke test failed. Log: $LOG"
fi

# ---------------------------------------------------------- 8. commit ---
step "8/8  Git commit"
cd "$PROJECT_DIR"
if [ -n "$(git log --oneline --grep='^L0:' 2>/dev/null || true)" ]; then
  # L0 was committed on an earlier run: never commit your own later changes for you.
  ok "L0 already committed ($(git log -1 --grep='^L0:' --pretty='%h'))"
  if [ -n "$(git status --porcelain)" ]; then
    warn "you have uncommitted changes (not committed by this script):"
    git status --short | sed 's/^/      /'
  fi
elif [ -z "$(git config user.name || true)" ] || [ -z "$(git config user.email || true)" ]; then
  warn "Git has no name/email yet. Set them, then commit:"
  info "  git config --global user.name \"Your Name\""
  info "  git config --global user.email \"you@example.com\""
  info "  git add -A && git commit -m \"L0: Mac setup and project skeleton\""
else
  git add -A
  STAGED="$(git diff --cached --name-only)"
  case "$(printf '%s\n' "$STAGED" | grep -E '(^|/)\.env$' || true)" in ?*) die ".env was about to be committed — aborting." ;; esac
  git commit -q -m "L0: Mac setup and project skeleton"
  ok "committed: $(git log -1 --pretty='%h %s')"
fi

printf '\n%sL0 complete.%s\n' "$G$B" "$N"
info "Project:  $PROJECT_DIR"
info "Run:      cd \"$PROJECT_DIR\" && npm run dev   → open http://127.0.0.1:5173"
info "Check:    npm run check"
[ $CONFLICTS -gt 0 ] && warn "$CONFLICTS file(s) saved as .new because yours differed — review them."
info "Next:     share this output; then phase L1 (login, users and roles)."