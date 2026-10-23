#!/usr/bin/env bash
# =============================================================================
# Claru Video Uploader — Phase L1: login, users and roles
#
# Run it from your project folder (the one L0 created), or pass --dir.
#
# What it does (each step explained as it runs):
#   1. Checks the project: L0 is committed, no unsaved work in the way
#   2. Makes sure PostgreSQL is running
#   3. Adds the L1 files and updates the L0 files it needs to change
#      (only if you have not edited them — otherwise L1's version is saved
#       beside yours as <file>.new and the script stops before committing)
#   4. Installs packages and applies the database migration to claru_dev
#   5. Runs typecheck, lint and the tests (42, including the access-control tests)
#   6. Creates your first admin account (asks for username and password)
#   7. Starts everything briefly and checks the security basics
#   8. Commits the result as "L1"
#
# Safe to re-run. Never drops a database, never commits your own changes.
#
# Usage:
#   ./claru-l1.sh [--dir PATH] [--yes] [--no-admin] [--no-smoke]
#   --dir        project folder (default: current folder if it is the project)
#   --yes        continue past the "uncommitted changes" question
#   --no-admin   skip creating an admin (create one later; see README.md)
#   --no-smoke   skip step 7
#
# Written for macOS's built-in Bash 3.2 and BSD tools.
# =============================================================================
set -euo pipefail

PROJECT_DIR=""
ASSUME_YES="no"
CREATE_ADMIN="yes"
RUN_SMOKE="yes"
CONFLICTS=0
CREATED=0
UPDATED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) PROJECT_DIR="$2"; shift 2 ;;
    --yes) ASSUME_YES="yes"; shift ;;
    --no-admin) CREATE_ADMIN="no"; shift ;;
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

has_tty() { ( : </dev/tty ) 2>/dev/null; }

confirm() {
  if [ "$ASSUME_YES" = "yes" ]; then return 0; fi
  local ans=""
  if has_tty; then read -r -p "   ? $1 [y/N] " ans </dev/tty || true; fi
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

sha_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

new_tmp() { mktemp "${TMPDIR:-/tmp}/cvu.XXXXXX"; }

# put_file <path>  — a file new in this phase (content on stdin)
put_file() {
  local path="$PROJECT_DIR/$1" tmp
  tmp="$(new_tmp)"; cat > "$tmp"
  mkdir -p "$(dirname "$path")"
  if [ ! -f "$path" ]; then
    mv "$tmp" "$path"; CREATED=$((CREATED + 1))
  elif cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
  else
    mv "$tmp" "$path.new"; CONFLICTS=$((CONFLICTS + 1))
    warn "$1 already exists with different content — kept yours, saved L1's as $1.new"
  fi
}

# update_file <path> <sha256 of the previous phase's version>  — a file this phase changes (content on stdin)
# Replaced only if it is still exactly the previous phase's version.
update_file() {
  local path="$PROJECT_DIR/$1" prev="$2" tmp cur
  tmp="$(new_tmp)"; cat > "$tmp"
  mkdir -p "$(dirname "$path")"
  if [ ! -f "$path" ]; then
    mv "$tmp" "$path"; CREATED=$((CREATED + 1))
  elif cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
  else
    cur="$(sha_of "$path")"
    if [ "$cur" = "$prev" ]; then
      mv "$tmp" "$path"; UPDATED=$((UPDATED + 1))
    else
      mv "$tmp" "$path.new"; CONFLICTS=$((CONFLICTS + 1))
      warn "$1 was edited since L0 — kept yours, saved L1's as $1.new (merge them, then re-run)"
    fi
  fi
}

env_value() { # env_value KEY — reads KEY from the project's .env
  sed -n "s/^$1=//p" "$PROJECT_DIR/.env" | tail -1
}

# ------------------------------------------------------- 1. the project ---
step "1/8  Checking the project"
if [ -z "$PROJECT_DIR" ]; then
  if [ -f package.json ] && grep -q '"name": "claru-video-uploader"' package.json; then
    PROJECT_DIR="$(pwd)"
  elif [ -f "${HOME}/Projects/claru-uploader/package.json" ]; then
    PROJECT_DIR="${HOME}/Projects/claru-uploader"
  else
    die "Run this from your project folder, or pass --dir /path/to/project."
  fi
fi
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
cd "$PROJECT_DIR"
grep -q '"name": "claru-video-uploader"' package.json 2>/dev/null || die "$PROJECT_DIR is not the Claru Video Uploader project."
info "project: $PROJECT_DIR"

for cmd in git node npm psql pg_isready curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' not found on PATH. Open a new terminal (so ~/.zshrc applies) and retry."
done
[ -f .env ] || die ".env is missing. Run the L0 script first."
[ -n "$(git log --oneline --grep='^L0:' 2>/dev/null || true)" ] || die "No L0 commit found. Finish L0 first."
ok "L0 is committed"

L1_DONE="no"
if [ -n "$(git log --oneline --grep='^L1:' 2>/dev/null || true)" ]; then
  L1_DONE="yes"
  ok "L1 already committed — re-run mode (checks only, nothing new is committed)"
fi

DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  warn "you have uncommitted changes to tracked files:"
  printf '%s\n' "$DIRTY" | sed 's/^/      /'
  info "L1 only replaces files you have not edited; edited ones get a .new copy instead."
  confirm "Continue anyway?" || die "Stopped. Commit or stash your changes (git stash), then re-run."
fi

# ------------------------------------------------------ 2. PostgreSQL ---
step "2/8  PostgreSQL"
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-5432}"; export PGHOST PGPORT
if ! pg_isready -q -h "$PGHOST" -p "$PGPORT"; then
  if command -v brew >/dev/null 2>&1; then
    info "starting PostgreSQL 16"
    brew services start postgresql@16 >/dev/null
    i=0; while ! pg_isready -q -h "$PGHOST" -p "$PGPORT"; do i=$((i + 1)); [ $i -gt 30 ] && die "PostgreSQL did not start. Check: brew services info postgresql@16"; sleep 1; done
  else
    die "PostgreSQL is not answering on $PGHOST:$PGPORT."
  fi
fi
ok "PostgreSQL answering on $PGHOST:$PGPORT"
DEV_DB_URL="$(env_value DATABASE_URL)"
[ -n "$DEV_DB_URL" ] || die "DATABASE_URL is not set in .env."

# ------------------------------------------------------- 3. the files ---
step "3/8  Adding and updating files"

update_file .env.example 53fc32a899d8371c15090c529e6a9c1041222712b2f86240896b6ee4a3521984 <<'CVU_L1_EOF'
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

# Sign-in sessions (L1). Defaults shown; remove a line to use the default.
SESSION_HOURS=12
# auto = Secure cookies only in production (HTTPS); yes / no to force
COOKIE_SECURE=auto
# no locally; loopback in production behind Caddy
TRUST_PROXY=no

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
CVU_L1_EOF

update_file README.md 0f56dc17f751a8fa7b3ab28dfcfc941404a80786309feae17bbe648fb921c3a9 <<'CVU_L1_EOF'
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
npm run dev                         # server :8080, web :5173, mock Claru :4010, mock Graph :4020
npm run check                       # typecheck + lint + tests
npm run db:migrate -w @cvu/server   # apply database migrations (the server also does this at start)
```

Create an admin (there is no web page for this, on purpose). The password is read from standard input:

```bash
read -r -s -p "Admin password: " PW; echo
printf '%s' "$PW" | npm run -s admin:create -w @cvu/server -- --username kk --display-name "Karthik" --password-stdin
unset PW
```

Open http://127.0.0.1:5173.

## Rules

- `.env` holds secrets and is never committed. `.env.example` lists every setting.
- Development talks to the mocks. Real Claru needs `ALLOW_REAL_CLARU=yes` and is used
  only in the controlled test.
- Each phase is applied by a script and committed as one Git commit.
- Consultants see only their own records: every query for owned data goes through
  `ownerScope()` in `server/src/access.ts`, and the tests try to break it.
CVU_L1_EOF

put_file docs/phases/L1.md <<'CVU_L1_EOF'
# Phase L1 — Login, users and roles

What it adds:

- Individual sign-in with sessions (HttpOnly, SameSite=Strict cookie; only an HMAC of the token is stored).
- Two roles. Admin: everything below. Consultant: signs in, changes own password; (uploads arrive in L2).
- Admin creates consultants; each gets a one-time password and must choose their own at first sign-in.
- Admin can disable / enable a consultant, reset a password, sign a consultant out everywhere.
- Throttling: 5 failed sign-ins per IP, or 10 per username, in 15 minutes → blocked for 15 minutes.
- Audit log of every sign-in, failure and account change (no passwords), viewable by the admin.
- `ownerScope()` — the single function every later query uses to limit consultants to their own rows.
- Database migrations (server/migrations), applied automatically when the server starts.
- Command-line tool to create an admin: `npm run admin:create -w @cvu/server`.

Gate:

- `npm run check` passes (tests try every admin route as a consultant and expect 403).
- In the browser: admin signs in → creates a consultant → consultant signs in with the one-time
  password → must change it → sees no admin pages → admin disables them → they are signed out.

Next: L2 — resumable upload.
CVU_L1_EOF

put_file server/migrations/001_auth.sql <<'CVU_L1_EOF'
-- L1: users, sessions and the audit log.

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             text NOT NULL,
  display_name         text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('admin', 'consultant')),
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  disabled_at          timestamptz,
  created_by           uuid REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- lowercase letters, digits, dot, dash, underscore; 2 to 32 characters
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX users_username_key ON users (username);

-- One row per signed-in browser. Only an HMAC of the session token is stored.
CREATE TABLE auth_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  ip             inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX auth_sessions_active_by_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- Append-only history of security-relevant actions. Never updated or deleted by the app.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users (id),
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  ip            inet,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_login_failed ON audit_log (at) WHERE action = 'login_failed';
CVU_L1_EOF

update_file server/package.json 88f53ca56da03125ace5965a4301c6d6f0946d2d803f52a6e987ab3c52c90b30 <<'CVU_L1_EOF'
{
  "name": "@cvu/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "db:migrate": "tsx scripts/migrate.ts",
    "admin:create": "tsx scripts/create-admin.ts",
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
CVU_L1_EOF

put_file server/scripts/create-admin.ts <<'CVU_L1_EOF'
// Creates the first (or another) admin account. There is deliberately no web page for this.
//
//   printf '%s' "$PASSWORD" | npm run admin:create -w @cvu/server -- --username kk --display-name "Karthik" --password-stdin
//
// The password is read from standard input so it never appears in shell history or `ps`.
import { audit } from '../src/audit.js';
import { hashPassword, passwordProblem } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { findUserByUsername, insertUser, USERNAME_PATTERN } from '../src/users.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const username = (arg('username') ?? '').trim().toLowerCase();
const displayName = (arg('display-name') ?? '').trim();
if (!USERNAME_PATTERN.test(username)) fail('--username: 2–32 lowercase letters, digits, dot, dash or underscore.');
if (!displayName || displayName.length > 80) fail('--display-name: 1–80 characters.');
if (!process.argv.includes('--password-stdin')) fail('Pass the password on standard input with --password-stdin.');

const password = await readStdin();
const problem = passwordProblem(password, username);
if (problem) fail(`Password not accepted: ${problem}`);

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  await migrate(pool);
  if (await findUserByUsername(pool, username)) fail(`A user named "${username}" already exists.`);
  const user = await insertUser(pool, {
    username,
    displayName,
    role: 'admin',
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
  });
  await audit(pool, { action: 'admin_created', targetType: 'user', targetId: user.id, details: { username, via: 'cli' } });
  console.warn(`✓ Admin "${username}" created.`);
} finally {
  await pool.end();
}
CVU_L1_EOF

put_file server/scripts/migrate.ts <<'CVU_L1_EOF'
// npm run db:migrate -w @cvu/server   — applies pending migrations to DATABASE_URL.
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  const applied = await migrate(pool);
  console.warn(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
} finally {
  await pool.end();
}
CVU_L1_EOF

put_file server/src/access.ts <<'CVU_L1_EOF'
import type { AuthUser } from './auth/sessions.js';

export interface Scope {
  /** SQL condition to AND into a WHERE clause. */
  sql: string;
  params: unknown[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * The one place that decides which rows a user may see.
 *
 * Every query for records that belong to someone (recordings, clips, backups,
 * notes) MUST include ownerScope(user, column) in its WHERE clause:
 * admins see every row; a consultant sees only rows whose owner column is their
 * own id. Placeholders start at $firstParam so the scope can follow other params.
 */
export function ownerScope(user: AuthUser, column: string, firstParam = 1): Scope {
  if (!IDENTIFIER.test(column)) throw new Error(`ownerScope: invalid column name "${column}"`);
  if (user.role === 'admin') return { sql: 'TRUE', params: [] };
  return { sql: `${column} = $${firstParam}`, params: [user.id] };
}
CVU_L1_EOF

update_file server/src/app.ts c6c1c32eab2dbd2efd7346b8294fcf239899ffbf30f60c824ce1e193d704b7db <<'CVU_L1_EOF'
import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { APP_NAME, type HealthReport } from '@cvu/shared';
import { csrfGuard, loadSession, requireAdmin, requireAuth, requirePasswordChanged } from './auth/middleware.js';
import { checkDb } from './db.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';

export interface AppDeps {
  pool: pg.Pool;
  logger: Logger;
  sessionSecret: string;
  sessionHours: number;
  cookieSecure: boolean;
  /** 'loopback' behind Caddy on the same server (production); 'no' locally. */
  trustProxy?: 'no' | 'loopback';
  startedAt?: number;
}

export function createApp(deps: AppDeps): express.Express {
  const { pool: db } = deps;
  const app = express();
  const startedAt = deps.startedAt ?? Date.now();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy === 'loopback' ? 'loopback' : false);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // Public: health only.
  app.get('/api/healthz', async (_req, res) => {
    const dbHealth = await checkDb(db);
    const body: HealthReport = {
      ok: dbHealth.ok,
      service: APP_NAME,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      db: dbHealth,
    };
    res.status(dbHealth.ok ? 200 : 503).json(body);
  });

  app.use('/api', csrfGuard(), loadSession(db, deps.sessionSecret));

  // Sign-in, sign-out, who am I, change password: allowed even with a temporary password.
  app.use(
    '/api/auth',
    authRoutes({ db, sessionSecret: deps.sessionSecret, sessionHours: deps.sessionHours, cookieSecure: deps.cookieSecure }),
  );

  // Everything below needs a signed-in user who has replaced any temporary password.
  app.use('/api', requireAuth, requirePasswordChanged);
  app.use('/api/admin', requireAdmin, adminRoutes(db));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
CVU_L1_EOF

put_file server/src/audit.ts <<'CVU_L1_EOF'
import type pg from 'pg';

export type AuditAction =
  | 'login_succeeded'
  | 'login_failed'
  | 'login_throttled'
  | 'logout'
  | 'password_changed'
  | 'user_created'
  | 'user_disabled'
  | 'user_enabled'
  | 'password_reset'
  | 'sessions_revoked'
  | 'admin_created';

export interface AuditEntry {
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Appends one row to audit_log. Never store passwords, tokens or keys in details. */
export async function audit(db: pg.Pool, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [e.actorUserId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.ip ?? null, JSON.stringify(e.details ?? {})],
  );
}
CVU_L1_EOF

put_file server/src/auth/middleware.ts <<'CVU_L1_EOF'
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
CVU_L1_EOF

put_file server/src/auth/password.ts <<'CVU_L1_EOF'
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

// scrypt with N=2^15, r=8: about 32 MB and tens of milliseconds per hash —
// slow enough to resist guessing, fast enough for five people logging in.
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

function scrypt(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Stored format: scrypt$N$r$p$saltBase64$hashBase64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let dummyHash: Promise<string> | undefined;
/**
 * A hash to verify against when the username does not exist, so a failed
 * login takes the same time whether or not the account is real.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64'));
  return dummyHash;
}

/** Returns a problem to show the user, or null if the password is acceptable. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  // Only meaningful for usernames of 4+ characters; a 2-letter name like "kk" would forbid too much.
  if (username.length >= 4 && password.toLowerCase().includes(username.toLowerCase())) return 'Do not include your username.';
  if (new Set(password).size < 5) return 'Use a less repetitive password.';
  return null;
}

// No 0/O, 1/l/I: easy to read aloud or copy by hand.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A one-time password the admin hands over; the user must change it at first sign-in. */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}
CVU_L1_EOF

put_file server/src/auth/sessions.ts <<'CVU_L1_EOF'
import { createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Role } from '@cvu/shared';

export const SESSION_COOKIE = 'cvu_session';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface SessionContext {
  sessionId: string;
  user: AuthUser;
}

/** 256 random bits, sent to the browser only. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores: an HMAC keyed with SESSION_SECRET, so a leaked table is useless. */
export function hashSessionToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
}

export async function createSession(
  db: pg.Pool,
  opts: { userId: string; ip?: string; userAgent?: string; hours: number; secret: string },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = newSessionToken();
  const r = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO auth_sessions (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
     RETURNING id, expires_at`,
    [opts.userId, hashSessionToken(token, opts.secret), opts.ip ?? null, opts.userAgent?.slice(0, 300) ?? null, opts.hours],
  );
  const row = r.rows[0]!;
  return { token, sessionId: row.id, expiresAt: row.expires_at };
}

/** A live session for an enabled user, or null. Refreshes last_seen_at at most once a minute. */
export async function findSession(db: pg.Pool, token: string, secret: string): Promise<SessionContext | null> {
  const r = await db.query<{
    session_id: string;
    last_seen_at: Date;
    id: string;
    username: string;
    display_name: string;
    role: Role;
    must_change_password: boolean;
  }>(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.username, u.display_name, u.role, u.must_change_password
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashSessionToken(token, secret)],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > 60_000) {
    await db.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: row.must_change_password,
    },
  };
}

export async function revokeSession(db: pg.Pool, sessionId: string, reason: string): Promise<void> {
  await db.query('UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
    reason,
  ]);
}

/** Ends every session of a user, optionally keeping one (the one making the request). Returns how many ended. */
export async function revokeUserSessions(
  db: pg.Pool,
  userId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<number> {
  const r = await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [userId, reason, exceptSessionId ?? null],
  );
  return r.rowCount ?? 0;
}
CVU_L1_EOF

put_file server/src/auth/throttle.ts <<'CVU_L1_EOF'
import type pg from 'pg';

export const THROTTLE_WINDOW_MINUTES = 15;
export const MAX_FAILURES_PER_IP = 5;
export const MAX_FAILURES_PER_USERNAME = 10;

/**
 * Counts failed logins in the last 15 minutes from the audit log, so the limit
 * survives restarts. Blocks an IP after 5 failures and a username after 10
 * (from any IP), until the window passes.
 */
export async function loginBlocked(db: pg.Pool, ip: string | undefined, username: string): Promise<boolean> {
  const r = await db.query<{ by_ip: string; by_user: string }>(
    `SELECT count(*) FILTER (WHERE ip = $1::inet)                 AS by_ip,
            count(*) FILTER (WHERE details->>'username' = $2)     AS by_user
       FROM audit_log
      WHERE action = 'login_failed' AND at > now() - make_interval(mins => $3)`,
    [ip ?? null, username, THROTTLE_WINDOW_MINUTES],
  );
  const row = r.rows[0]!;
  return Number(row.by_ip) >= MAX_FAILURES_PER_IP || Number(row.by_user) >= MAX_FAILURES_PER_USERNAME;
}
CVU_L1_EOF

update_file server/src/config.ts 2dee4d00082492e7f96da893ab7bcdb1ac8caadae106161158b9c8815acb3018 <<'CVU_L1_EOF'
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
    SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12),
    COOKIE_SECURE: z.enum(['auto', 'yes', 'no']).default('auto'),
    TRUST_PROXY: z.enum(['no', 'loopback']).default('no'),
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

/** Secure cookies need HTTPS: on in production, off on http://localhost, unless set explicitly. */
export function cookieSecure(c: Config): boolean {
  return c.COOKIE_SECURE === 'auto' ? c.NODE_ENV === 'production' : c.COOKIE_SECURE === 'yes';
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
CVU_L1_EOF

update_file server/src/index.ts a3fc46cdad39144b0795a8f8898608b3c17432ab58bfaff3014f3dafa5f4309f <<'CVU_L1_EOF'
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { cookieSecure, describeConfig, loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

for (const dir of [config.WORK_DIR, config.TUS_DIR]) mkdirSync(dir, { recursive: true });

const pool = createPool(config.DATABASE_URL);

const applied = await migrate(pool);
if (applied.length) logger.info({ applied }, 'database migrations applied');

const app = createApp({
  pool,
  logger,
  sessionSecret: config.SESSION_SECRET,
  sessionHours: config.SESSION_HOURS,
  cookieSecure: cookieSecure(config),
  trustProxy: config.TRUST_PROXY,
});

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
CVU_L1_EOF

put_file server/src/migrate.ts <<'CVU_L1_EOF'
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Any constant works; it only has to be the same in every process that migrates.
const LOCK_KEY = 4_217_001;

/**
 * Applies every migrations/NNN_name.sql not yet recorded in schema_migrations,
 * in name order, each in its own transaction. Safe to run from several processes
 * at once (an advisory lock serialises them). Returns the versions applied.
 */
export async function migrate(pool: pg.Pool, dir = migrationsDir): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      const sql = readFileSync(resolve(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
CVU_L1_EOF

put_file server/src/routes/admin.ts <<'CVU_L1_EOF'
import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditView } from '@cvu/shared';
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

  return router;
}
CVU_L1_EOF

put_file server/src/routes/auth.ts <<'CVU_L1_EOF'
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
CVU_L1_EOF

put_file server/src/users.ts <<'CVU_L1_EOF'
import type pg from 'pg';
import type { PublicUser, Role, UserSummary } from '@cvu/shared';

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  must_change_password: boolean;
  disabled_at: Date | null;
  created_at: Date;
}

export function toPublicUser(u: Pick<UserRow, 'id' | 'username' | 'display_name' | 'role' | 'must_change_password'>): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    mustChangePassword: u.must_change_password,
  };
}

export async function findUserByUsername(db: pg.Pool, username: string): Promise<UserRow | null> {
  const r = await db.query<UserRow>('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
  return r.rows[0] ?? null;
}

export async function findUserById(db: pg.Pool, id: string): Promise<UserRow | null> {
  const r = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function insertUser(
  db: pg.Pool,
  u: { username: string; displayName: string; role: Role; passwordHash: string; mustChangePassword: boolean; createdBy?: string },
): Promise<UserRow> {
  const r = await db.query<UserRow>(
    `INSERT INTO users (username, display_name, role, password_hash, must_change_password, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [u.username.toLowerCase(), u.displayName, u.role, u.passwordHash, u.mustChangePassword, u.createdBy ?? null],
  );
  return r.rows[0]!;
}

export async function listUsers(db: pg.Pool): Promise<UserSummary[]> {
  const r = await db.query<{
    id: string;
    username: string;
    display_name: string;
    role: Role;
    must_change_password: boolean;
    disabled_at: Date | null;
    created_at: Date;
    last_sign_in: Date | null;
    active_sessions: string;
  }>(
    `SELECT u.id, u.username, u.display_name, u.role, u.must_change_password, u.disabled_at, u.created_at,
            max(s.created_at) AS last_sign_in,
            count(s.id) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
       FROM users u LEFT JOIN auth_sessions s ON s.user_id = u.id
      GROUP BY u.id
      ORDER BY u.role, u.username`,
  );
  return r.rows.map((u) => ({
    ...toPublicUser(u),
    disabled: u.disabled_at !== null,
    createdAt: u.created_at.toISOString(),
    lastSignInAt: u.last_sign_in?.toISOString() ?? null,
    activeSessions: Number(u.active_sessions),
  }));
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
CVU_L1_EOF

put_file server/test/admin.test.ts <<'CVU_L1_EOF'
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, Client, createAdmin, resetDatabase, startApp, testPool } from './helpers.js';

const db = testPool();
let server: Server;
let base = '';
let admin: Client;
let adminId = '';

beforeAll(async () => {
  ({ server, base } = await startApp(db));
});
beforeEach(async () => {
  await resetDatabase(db);
  adminId = await createAdmin(db);
  admin = new Client(base);
  await admin.login('boss', ADMIN_PASSWORD);
});
afterAll(async () => {
  server.close();
  await db.end();
});

/** Creates a consultant and signs them in with a permanent password. */
async function consultant(username: string): Promise<{ client: Client; id: string; password: string }> {
  const created = await admin.post('/api/admin/users', { username, displayName: `Consultant ${username}` });
  expect(created.status).toBe(201);
  const client = new Client(base);
  await client.login(username, created.body.temporaryPassword);
  const password = `Permanent-pass-${username.length}-Xy7q`; // must not contain the username
  expect((await client.post('/api/auth/change-password', { currentPassword: created.body.temporaryPassword, newPassword: password })).status).toBe(200);
  return { client, id: created.body.user.id, password };
}

describe('creating consultants', () => {
  it('creates a consultant with a one-time password they must change', async () => {
    const res = await admin.post('/api/admin/users', { username: 'Ravi.K', displayName: 'Ravi Kumar' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ username: 'ravi.k', role: 'consultant', mustChangePassword: true });
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);

    const ravi = new Client(base);
    expect((await ravi.login('ravi.k', res.body.temporaryPassword)).body.user.mustChangePassword).toBe(true);
    // Until the password is changed, only /api/auth/* works.
    expect((await ravi.get('/api/admin/users')).body.error).toBe('password_change_required');
    expect((await ravi.get('/api/auth/me')).status).toBe(200);
  });

  it('refuses a duplicate username, case-insensitively', async () => {
    await admin.post('/api/admin/users', { username: 'priya', displayName: 'Priya' });
    const dup = await admin.post('/api/admin/users', { username: 'PRIYA', displayName: 'Another Priya' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('username_taken');
  });

  it('refuses invalid usernames', async () => {
    for (const username of ['a', 'has space', 'émoji', '-starts-with-dash', 'x'.repeat(40)]) {
      expect((await admin.post('/api/admin/users', { username, displayName: 'X' })).status).toBe(400);
    }
  });

  it('never returns password hashes in the user list', async () => {
    await admin.post('/api/admin/users', { username: 'priya', displayName: 'Priya' });
    const list = await admin.get('/api/admin/users');
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toMatch(/scrypt|password_hash|passwordHash/);
  });
});

describe('what a consultant cannot do', () => {
  it('cannot use any admin route', async () => {
    const { client } = await consultant('priya');
    const other = await consultant('ravi');
    const attempts = [
      client.get('/api/admin/users'),
      client.get('/api/admin/audit'),
      client.post('/api/admin/users', { username: 'sneaky', displayName: 'Sneaky' }),
      client.post(`/api/admin/users/${other.id}/disable`),
      client.post(`/api/admin/users/${other.id}/reset-password`),
      client.post(`/api/admin/users/${adminId}/disable`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('admin_only');
    }
    expect((await db.query("SELECT 1 FROM users WHERE username = 'sneaky'")).rowCount).toBe(0);
  });
});

describe('managing consultants', () => {
  it('disabling signs the consultant out immediately and blocks new sign-ins', async () => {
    const priya = await consultant('priya');
    expect((await priya.client.get('/api/auth/me')).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${priya.id}/disable`)).status).toBe(200);
    expect((await priya.client.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(base).login('priya', priya.password)).status).toBe(401);

    expect((await admin.post(`/api/admin/users/${priya.id}/enable`)).status).toBe(200);
    expect((await new Client(base).login('priya', priya.password)).status).toBe(200);
  });

  it('resetting a password ends sessions and issues a new one-time password', async () => {
    const priya = await consultant('priya');
    const reset = await admin.post(`/api/admin/users/${priya.id}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await priya.client.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(base).login('priya', priya.password)).status).toBe(401);
    const again = new Client(base);
    expect((await again.login('priya', reset.body.temporaryPassword)).body.user.mustChangePassword).toBe(true);
  });

  it('can end all of a consultant’s sessions', async () => {
    const priya = await consultant('priya');
    const res = await admin.post(`/api/admin/users/${priya.id}/revoke-sessions`);
    expect(res.body.sessionsEnded).toBe(1);
    expect((await priya.client.get('/api/auth/me')).status).toBe(401);
  });

  it('does not manage admin accounts through the API', async () => {
    expect((await admin.post(`/api/admin/users/${adminId}/disable`)).body.error).toBe('cannot_modify_admin');
  });

  it('answers 404 for unknown or malformed ids', async () => {
    expect((await admin.post('/api/admin/users/00000000-0000-0000-0000-000000000000/disable')).status).toBe(404);
    expect((await admin.post('/api/admin/users/not-a-uuid/disable')).status).toBe(404);
  });

  it('records every admin action in the audit log', async () => {
    const priya = await consultant('priya');
    await admin.post(`/api/admin/users/${priya.id}/disable`);
    const audit = await admin.get('/api/admin/audit?limit=50');
    const actions = (audit.body.entries as Array<{ action: string; actor: string | null }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user_created', 'user_disabled', 'password_changed', 'login_succeeded']));
    expect(JSON.stringify(audit.body)).not.toMatch(/Permanent-pass|scrypt/);
  });
});
CVU_L1_EOF

put_file server/test/auth.test.ts <<'CVU_L1_EOF'
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../src/auth/sessions.js';
import { ADMIN_PASSWORD, Client, createAdmin, resetDatabase, startApp, TEST_SECRET, testPool } from './helpers.js';

const db = testPool();
let server: Server;
let base = '';

beforeAll(async () => {
  ({ server, base } = await startApp(db));
});
beforeEach(async () => {
  await resetDatabase(db);
  await createAdmin(db);
});
afterAll(async () => {
  server.close();
  await db.end();
});

describe('sign-in', () => {
  it('signs in with the right password and sets a locked-down cookie', async () => {
    const c = new Client(base);
    const res = await c.login('boss', ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'boss', role: 'admin', mustChangePassword: false });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.setCookie).toMatch(/cvu_session=/);
    expect(res.setCookie).toMatch(/HttpOnly/i);
    expect(res.setCookie).toMatch(/SameSite=Strict/i);
    expect((await c.get('/api/auth/me')).body.user.username).toBe('boss');
  });

  it('accepts the username in any case and with spaces around it', async () => {
    expect((await new Client(base).login('  BOSS ', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const wrong = await new Client(base).login('boss', 'not-the-password');
    const unknown = await new Client(base).login('nobody', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'invalid_credentials' });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('stores only an HMAC of the session token, never the token', async () => {
    const c = new Client(base);
    await c.login('boss', ADMIN_PASSWORD);
    const token = c.cookie.split('=')[1]!;
    const rows = (await db.query<{ token_hash: string }>('SELECT token_hash FROM auth_sessions')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toBe(hashSessionToken(token, TEST_SECRET));
  });

  it('blocks an address after 5 failures in 15 minutes, even with the right password', async () => {
    const c = new Client(base);
    for (let i = 0; i < 5; i++) expect((await c.login('boss', `wrong-${i}`)).status).toBe(401);
    const blocked = await c.login('boss', ADMIN_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_attempts');
  });

  it('records successes and failures in the audit log, without passwords', async () => {
    await new Client(base).login('boss', 'wrong-password-1');
    await new Client(base).login('boss', ADMIN_PASSWORD);
    const rows = (await db.query<{ action: string; details: unknown }>('SELECT action, details FROM audit_log ORDER BY id')).rows;
    expect(rows.map((r) => r.action)).toEqual(['login_failed', 'login_succeeded']);
    expect(JSON.stringify(rows)).not.toContain('wrong-password-1');
    expect(JSON.stringify(rows)).not.toContain(ADMIN_PASSWORD);
  });
});

describe('sessions', () => {
  it('rejects requests without a session', async () => {
    expect((await new Client(base).get('/api/auth/me')).status).toBe(401);
  });

  it('ends the session on sign-out; the old cookie stops working', async () => {
    const c = new Client(base);
    await c.login('boss', ADMIN_PASSWORD);
    const oldCookie = c.cookie;
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    const replay = new Client(base);
    replay.cookie = oldCookie;
    expect((await replay.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const c = new Client(base);
    await c.login('boss', ADMIN_PASSWORD);
    await db.query("UPDATE auth_sessions SET expires_at = now() - interval '1 minute'");
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a made-up cookie', async () => {
    const c = new Client(base);
    c.cookie = 'cvu_session=' + 'A'.repeat(43);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('cross-site request protection', () => {
  it('refuses a state-changing call without the X-Requested-With header', async () => {
    const res = await new Client(base).post('/api/auth/login', { username: 'boss', password: ADMIN_PASSWORD }, { csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_header_missing');
  });
});

describe('changing your password', () => {
  it('requires the current password, rejects weak ones, and ends your other sessions', async () => {
    const phone = new Client(base);
    const laptop = new Client(base);
    await phone.login('boss', ADMIN_PASSWORD);
    await laptop.login('boss', ADMIN_PASSWORD);

    expect((await laptop.post('/api/auth/change-password', { currentPassword: 'nope', newPassword: 'Another-long-pass-1' })).status).toBe(401);
    const weak = await laptop.post('/api/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toBe('weak_password');
    const withName = await laptop.post('/api/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'my-name-is-boss-ok' });
    expect(withName.body.error).toBe('weak_password');

    const ok = await laptop.post('/api/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'Another-long-pass-1' });
    expect(ok.status).toBe(200);
    expect((await laptop.get('/api/auth/me')).status).toBe(200); // this session stays
    expect((await phone.get('/api/auth/me')).status).toBe(401); // the other one ended
    expect((await new Client(base).login('boss', 'Another-long-pass-1')).status).toBe(200);
  });
});
CVU_L1_EOF

update_file server/test/health.test.ts de8b876df16ebda8d5775cb5c384b919dd1fb0afce141b9c971f5d02026128f3 <<'CVU_L1_EOF'
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthReport } from '@cvu/shared';
import { resetDatabase, startApp, testPool } from './helpers.js';

const db = testPool();
let server: Server;
let base = '';

beforeAll(async () => {
  await resetDatabase(db);
  ({ server, base } = await startApp(db));
});

afterAll(async () => {
  server.close();
  await db.end();
});

describe('GET /api/healthz', () => {
  it('reports the database as up, without signing in', async () => {
    const res = await fetch(`${base}/api/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.db.version).toMatch(/^\d+/);
  });

  it('sends basic security headers', async () => {
    const res = await fetch(`${base}/api/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('hides every other API path behind sign-in', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_signed_in' });
  });
});
CVU_L1_EOF

put_file server/test/helpers.ts <<'CVU_L1_EOF'
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { CSRF_HEADER, CSRF_VALUE } from '../src/auth/middleware.js';
import { hashPassword } from '../src/auth/password.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { migrate } from '../src/migrate.js';
import { insertUser } from '../src/users.js';

export const TEST_SECRET = 't'.repeat(48);
export const ADMIN_PASSWORD = 'Admin-password-123';

const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/claru_test';

/** Refuses to touch anything but a database whose name ends in _test. */
export function testPool(): pg.Pool {
  const name = new URL(dbUrl).pathname.slice(1);
  if (!name.endsWith('_test')) throw new Error(`Tests only run against a *_test database, not "${name}"`);
  return createPool(dbUrl);
}

/** Drops and recreates the test schema, then applies all migrations. */
export async function resetDatabase(db: pg.Pool): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

export async function startApp(db: pg.Pool): Promise<{ server: Server; base: string }> {
  const app = createApp({
    pool: db,
    logger: createLogger('silent'),
    sessionSecret: TEST_SECRET,
    sessionHours: 12,
    cookieSecure: false,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function createAdmin(db: pg.Pool, username = 'boss'): Promise<string> {
  const u = await insertUser(db, {
    username,
    displayName: 'The Admin',
    role: 'admin',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    mustChangePassword: false,
  });
  return u.id;
}

/** A tiny browser: keeps the session cookie and always sends the CSRF header. */
export class Client {
  cookie = '';
  constructor(private readonly base: string) {}

  async request(method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.csrf !== false) headers[CSRF_HEADER] = CSRF_VALUE;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0] ?? '';
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are checked field by field
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, any>, setCookie };
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown, opts?: { csrf?: boolean }) {
    return this.request('POST', path, body ?? {}, opts);
  }
  async login(username: string, password: string) {
    return this.post('/api/auth/login', { username, password });
  }
}
CVU_L1_EOF

put_file server/test/unit.test.ts <<'CVU_L1_EOF'
import { describe, expect, it } from 'vitest';
import { ownerScope } from '../src/access.js';
import { generateTemporaryPassword, hashPassword, passwordProblem, verifyPassword } from '../src/auth/password.js';
import type { AuthUser } from '../src/auth/sessions.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterY', stored)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('salts every hash differently', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('explains what is wrong with a weak password', () => {
    expect(passwordProblem('short', 'priya')).toMatch(/at least 12/);
    expect(passwordProblem('i-am-priya-123', 'priya')).toMatch(/username/);
    expect(passwordProblem('aaaaaaaaaaaaaaaa', 'priya')).toMatch(/repetitive/);
    expect(passwordProblem('Long-enough-pass-9', 'priya')).toBeNull();
    expect(passwordProblem('Kk-admin-password-9', 'kk')).toBeNull(); // too short a name to check
  });

  it('generates readable one-time passwords', () => {
    const p = generateTemporaryPassword();
    expect(p).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    expect(p).not.toMatch(/[0O1lI]/);
  });
});

describe('ownerScope', () => {
  const admin: AuthUser = { id: 'a', username: 'boss', displayName: 'B', role: 'admin', mustChangePassword: false };
  const consultant: AuthUser = { id: 'c-1', username: 'priya', displayName: 'P', role: 'consultant', mustChangePassword: false };

  it('lets an admin see every row', () => {
    expect(ownerScope(admin, 'r.uploaded_by')).toEqual({ sql: 'TRUE', params: [] });
  });

  it('limits a consultant to their own rows', () => {
    expect(ownerScope(consultant, 'r.uploaded_by', 3)).toEqual({ sql: 'r.uploaded_by = $3', params: ['c-1'] });
  });

  it('refuses anything that is not a plain column name', () => {
    expect(() => ownerScope(consultant, 'uploaded_by OR 1=1')).toThrow(/invalid column/);
  });
});
CVU_L1_EOF

update_file server/tsconfig.json 600dd0bec261e8f2b287298a712c533517fbc59e0fcdbb44c0c4b3fde29c4eb7 <<'CVU_L1_EOF'
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test", "scripts", "vitest.config.ts"]
}
CVU_L1_EOF

update_file server/vitest.config.ts 8efb900ce59e7d70e7f8f97094e77c67224b021cdebe812a975fb784e1592521 <<'CVU_L1_EOF'
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests read TEST_DATABASE_URL from the repo's .env (never the dev database).
const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    // All server tests share the claru_test database, so files run one at a time.
    fileParallelism: false,
  },
});
CVU_L1_EOF

update_file shared/src/index.ts d9959b3ee04fe802274f1fdb873dc2dc3738788ee959060c49e8894a2cb90a69 <<'CVU_L1_EOF'
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

/** What the API ever reveals about a user. Never includes the password hash. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

/** One row of the admin's user list. */
export interface UserSummary extends PublicUser {
  disabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  activeSessions: number;
}

/** One row of the admin's audit view. */
export interface AuditView {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

/** Error codes the API returns as { error: code }. */
export type ApiErrorCode =
  | 'not_signed_in'
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'password_change_required'
  | 'admin_only'
  | 'csrf_header_missing'
  | 'invalid_input'
  | 'weak_password'
  | 'username_taken'
  | 'not_found'
  | 'cannot_modify_admin';
CVU_L1_EOF

update_file web/src/App.tsx d5ef90b5a55ed1711f04c8bcce49f56ef3c5852618a71d88783976cafe516b4d <<'CVU_L1_EOF'
import { useCallback, useEffect, useState } from 'react';
import type { PublicUser } from '@cvu/shared';
import { api, ApiError } from './api.js';
import { AuditPage } from './pages/Audit.js';
import { ChangePasswordPage } from './pages/ChangePassword.js';
import { HomePage } from './pages/Home.js';
import { LoginPage } from './pages/Login.js';
import { UsersPage } from './pages/Users.js';

type Page = 'home' | 'users' | 'audit' | 'password';

export function App() {
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');

  const refresh = useCallback(() => {
    api<{ user: PublicUser }>('GET', '/auth/me')
      .then((r) => setUser(r.user))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setUser(null);
        else setUser(null);
      });
  }, []);

  useEffect(refresh, [refresh]);

  async function signOut() {
    await api('POST', '/auth/logout').catch(() => undefined);
    setUser(null);
    setPage('home');
  }

  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (user === null) return <LoginPage onSignedIn={(u) => { setUser(u); setPage('home'); }} />;
  if (user.mustChangePassword) {
    return <ChangePasswordPage user={user} forced onDone={(u) => setUser(u)} onSignOut={signOut} />;
  }

  const nav: Array<[Page, string]> = [['home', 'Home']];
  if (user.role === 'admin') nav.push(['users', 'Users'], ['audit', 'Audit log']);
  nav.push(['password', 'Change password']);

  return (
    <>
      <header className="topbar">
        <strong>Claru Video Uploader</strong>
        <nav>
          {nav.map(([key, label]) => (
            <button key={key} className={page === key ? 'link active' : 'link'} onClick={() => setPage(key)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="muted">
          {user.displayName} · {user.role}
        </span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main>
        {page === 'home' && <HomePage user={user} />}
        {page === 'users' && user.role === 'admin' && <UsersPage me={user} />}
        {page === 'audit' && user.role === 'admin' && <AuditPage />}
        {page === 'password' && <ChangePasswordPage user={user} onDone={(u) => { setUser(u); setPage('home'); }} />}
      </main>
    </>
  );
}
CVU_L1_EOF

put_file web/src/api.ts <<'CVU_L1_EOF'
import type { ApiErrorCode } from '@cvu/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network_error' | 'unknown',
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** JSON call to our own server. Always sends the CSRF header; the cookie travels automatically. */
export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'cvu',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorCode; message?: string } & T;
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'unknown', data.message);
  return data;
}

const MESSAGES: Partial<Record<ApiError['code'], string>> = {
  invalid_credentials: 'Wrong username or password.',
  too_many_attempts: 'Too many failed attempts. Wait 15 minutes and try again.',
  username_taken: 'That username is already in use.',
  admin_only: 'Only the admin can do that.',
  network_error: 'Cannot reach the server.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message !== err.code ? err.message : (MESSAGES[err.code] ?? `Error: ${err.code}`);
  return String(err);
}
CVU_L1_EOF

update_file web/src/main.tsx caccd29fa4fe92b08f7d06af4e6fcea33152be4e1369bd494b9b21fc5e10d42d <<'CVU_L1_EOF'
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
CVU_L1_EOF

put_file web/src/pages/Audit.tsx <<'CVU_L1_EOF'
import { useEffect, useState } from 'react';
import type { AuditView } from '@cvu/shared';
import { api, errorText } from '../api.js';

export function AuditPage() {
  const [entries, setEntries] = useState<AuditView[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ entries: AuditView[] }>('GET', '/admin/audit?limit=200')
      .then((r) => setEntries(r.entries))
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  return (
    <section className="card">
      <h2>Audit log</h2>
      <p className="muted small">Sign-ins, failures and account changes, newest first. Passwords are never recorded.</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Details</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="nowrap">{new Date(e.at).toLocaleString()}</td>
              <td>{e.actor ?? '—'}</td>
              <td>{e.action.replace(/_/g, ' ')}</td>
              <td className="small mono">{Object.keys(e.details).length ? JSON.stringify(e.details) : ''}</td>
              <td className="small">{e.ip ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
CVU_L1_EOF

put_file web/src/pages/ChangePassword.tsx <<'CVU_L1_EOF'
import { useState, type FormEvent } from 'react';
import type { PublicUser } from '@cvu/shared';
import { api, errorText } from '../api.js';

interface Props {
  user: PublicUser;
  forced?: boolean;
  onDone: (u: PublicUser) => void;
  onSignOut?: () => void;
}

export function ChangePasswordPage({ user, forced, onDone, onSignOut }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: PublicUser }>('POST', '/auth/change-password', { currentPassword: current, newPassword: next });
      onDone(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={forced ? 'center' : undefined}>
      <form className="card narrow" onSubmit={submit}>
        <h1>{forced ? 'Choose your password' : 'Change password'}</h1>
        {forced && (
          <p>
            Hello {user.displayName}. You signed in with a one-time password. Choose your own password to continue.
          </p>
        )}
        <label>
          {forced ? 'One-time password' : 'Current password'}
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </label>
        <label>
          New password again
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </label>
        <p className="muted small">At least 12 characters, not containing your username. Your other signed-in devices will be signed out.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
          {forced && onSignOut && (
            <button type="button" className="link" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
CVU_L1_EOF

put_file web/src/pages/Home.tsx <<'CVU_L1_EOF'
import { useEffect, useState } from 'react';
import type { HealthReport, PublicUser } from '@cvu/shared';

export function HomePage({ user }: { user: PublicUser }) {
  const [health, setHealth] = useState<HealthReport | null>(null);

  useEffect(() => {
    fetch('/api/healthz')
      .then((r) => r.json() as Promise<HealthReport>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <section className="card">
      <h1>Welcome, {user.displayName}</h1>
      <p>
        Signed in as <strong>{user.username}</strong> ({user.role}).
      </p>
      <p className="muted">Uploading arrives in phase L2.</p>
      {health && (
        <p className={health.ok ? 'ok' : 'error'}>
          {health.ok ? '✓' : '✗'} Server and database {health.ok ? `up (PostgreSQL ${health.db.version})` : 'not healthy'}
        </p>
      )}
    </section>
  );
}
CVU_L1_EOF

put_file web/src/pages/Login.tsx <<'CVU_L1_EOF'
import { useState, type FormEvent } from 'react';
import type { PublicUser } from '@cvu/shared';
import { api, errorText } from '../api.js';

export function LoginPage({ onSignedIn }: { onSignedIn: (u: PublicUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: PublicUser }>('POST', '/auth/login', { username, password });
      onSignedIn(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>Claru Video Uploader</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
CVU_L1_EOF

put_file web/src/pages/Users.tsx <<'CVU_L1_EOF'
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PublicUser, UserSummary } from '@cvu/shared';
import { api, errorText } from '../api.js';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function UsersPage({ me }: { me: PublicUser }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ username: string; password: string; what: string } | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');

  const load = useCallback(() => {
    api<{ users: UserSummary[] }>('GET', '/admin/users')
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ user: PublicUser; temporaryPassword: string }>('POST', '/admin/users', { username, displayName });
      setNotice({ username: r.user.username, password: r.temporaryPassword, what: 'created' });
      setUsername('');
      setDisplayName('');
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function act(u: UserSummary, action: 'disable' | 'enable' | 'reset-password' | 'revoke-sessions') {
    const questions = {
      disable: `Disable ${u.username}? They are signed out at once and cannot sign in.`,
      enable: null,
      'reset-password': `Reset ${u.username}'s password? They are signed out and get a new one-time password.`,
      'revoke-sessions': `Sign ${u.username} out on every device?`,
    } as const;
    const q = questions[action];
    if (q && !window.confirm(q)) return;
    setError('');
    try {
      const r = await api<{ temporaryPassword?: string }>('POST', `/admin/users/${u.id}/${action}`);
      if (r.temporaryPassword) setNotice({ username: u.username, password: r.temporaryPassword, what: 'reset' });
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      {notice && (
        <section className="card notice" role="status">
          <strong>
            One-time password for {notice.username} ({notice.what}):
          </strong>
          <code className="big">{notice.password}</code>
          <p className="small">
            Give it to {notice.username} in person or by phone. It is shown only now; they must choose their own password at first
            sign-in.
          </p>
          <button className="link" onClick={() => setNotice(null)}>
            I have noted it
          </button>
        </section>
      )}

      <section className="card">
        <h2>Add a consultant</h2>
        <form className="row wrap" onSubmit={create}>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ravi.k" required />
          </label>
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ravi Kumar" required />
          </label>
          <button className="primary">Create</button>
        </form>
        <p className="muted small">Usernames: 2–32 lowercase letters, digits, dot, dash or underscore.</p>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="card">
        <h2>Users</h2>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th>Signed in on</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName}
                  <div className="muted small">{u.username}</div>
                </td>
                <td>{u.role}</td>
                <td>{u.disabled ? 'disabled' : u.mustChangePassword ? 'must set password' : 'active'}</td>
                <td>{when(u.lastSignInAt)}</td>
                <td>
                  {u.activeSessions} device{u.activeSessions === 1 ? '' : 's'}
                </td>
                <td className="actions">
                  {u.role === 'consultant' && u.id !== me.id && (
                    <>
                      {u.disabled ? (
                        <button className="link" onClick={() => act(u, 'enable')}>Enable</button>
                      ) : (
                        <button className="link" onClick={() => act(u, 'disable')}>Disable</button>
                      )}
                      <button className="link" onClick={() => act(u, 'reset-password')}>Reset password</button>
                      {u.activeSessions > 0 && (
                        <button className="link" onClick={() => act(u, 'revoke-sessions')}>Sign out everywhere</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
CVU_L1_EOF

put_file web/src/styles.css <<'CVU_L1_EOF'
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #17191c;
  --muted: #646a73;
  --line: #e2e5ea;
  --accent: #2b59c3;
  --ok: #1d7a46;
  --bad: #b42318;
  --notice: #fff6e6;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--text);
  background: var(--bg);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111317;
    --panel: #1a1d22;
    --text: #e8eaed;
    --muted: #9aa1ab;
    --line: #2c3037;
    --accent: #7aa2ff;
    --ok: #5fd08f;
    --bad: #ff8a7a;
    --notice: #2d2412;
  }
}
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 1000px; margin: 0 auto; padding: 20px 16px 48px; }
main.center { min-height: 100vh; display: grid; place-items: center; }
h1 { font-size: 1.4rem; margin: 0 0 12px; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
.topbar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
.topbar nav { display: flex; gap: 8px; flex: 1; flex-wrap: wrap; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 16px; }
.card.narrow { width: min(380px, 100%); display: grid; gap: 12px; }
.notice { background: var(--notice); }
label { display: grid; gap: 4px; font-size: 0.9rem; }
input { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); }
button { font: inherit; cursor: pointer; }
button.primary { padding: 8px 16px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; }
button.primary:disabled { opacity: 0.6; cursor: default; }
button.link { border: 0; background: none; color: var(--accent); padding: 4px 6px; }
button.link.active { font-weight: 600; text-decoration: underline; }
.row { display: flex; gap: 12px; align-items: end; }
.row.wrap { flex-wrap: wrap; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 0.8rem; }
.actions { white-space: nowrap; }
.muted { color: var(--muted); }
.small { font-size: 0.82rem; }
.mono, code { font-family: ui-monospace, Menlo, monospace; }
code.big { display: block; font-size: 1.4rem; margin: 8px 0; letter-spacing: 0.05em; }
.nowrap { white-space: nowrap; }
.ok { color: var(--ok); }
.error { color: var(--bad); }
CVU_L1_EOF


ok "$CREATED new, $UPDATED updated$( [ $CONFLICTS -gt 0 ] && printf ', %s kept as yours (.new beside them)' "$CONFLICTS" )"
if [ $CONFLICTS -gt 0 ]; then
  die "Some files were edited since L0, so L1 could not update them safely.
   For each <file>.new listed above: compare it with your <file> (for example: diff -u server/src/app.ts server/src/app.ts.new),
   keep the parts you need, replace <file> with the merged result, delete the .new file, then re-run this script."
fi

# ------------------------------------------- 4. packages + migration ---
step "4/8  Packages and database migration"
info "npm install"
npm install --no-audit --no-fund --loglevel=error
ok "packages installed"
info "applying migrations to the development database"
npm run -s db:migrate -w @cvu/server
ok "database ready"

# ------------------------------------------------------------ 5. checks ---
step "5/8  Typecheck, lint, tests"
run_check() {
  local label="$1"; shift
  info "$label"
  if "$@"; then ok "$label passed"; else die "$label failed — see the messages above. Send me the output."; fi
}
run_check "typecheck" npm run -s typecheck
run_check "lint" npm run -s lint
run_check "tests" npm test --silent

# ------------------------------------------------------- 6. first admin ---
step "6/8  First admin account"
ADMINS="$(psql "$DEV_DB_URL" -tAc "SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL")"
if [ "${ADMINS:-0}" -gt 0 ]; then
  ok "an admin already exists ($ADMINS) — nothing to do"
elif [ "$CREATE_ADMIN" = "no" ] || ! has_tty; then
  warn "no admin yet. Create one later — see \"Create an admin\" in README.md"
else
  info "There is no admin yet. Choose the admin's sign-in details."
  info "Username: 2–32 lowercase letters, digits, dot, dash or underscore. Password: at least 12 characters."
  ADMIN_USER=""; ADMIN_NAME=""; P1=""; P2=""
  read -r -p "   Admin username: " ADMIN_USER </dev/tty
  read -r -p "   Display name (e.g. Karthik): " ADMIN_NAME </dev/tty
  tries=0
  while :; do
    read -r -s -p "   Password (hidden): " P1 </dev/tty; echo
    read -r -s -p "   Same password again: " P2 </dev/tty; echo
    if [ "$P1" = "$P2" ]; then break; fi
    tries=$((tries + 1)); [ $tries -ge 3 ] && die "Passwords did not match. Re-run to try again."
    warn "the two passwords differ — try again"
  done
  if printf '%s' "$P1" | npm run -s admin:create -w @cvu/server -- --username "$ADMIN_USER" --display-name "$ADMIN_NAME" --password-stdin; then
    ok "admin created — sign in at http://127.0.0.1:5173 after 'npm run dev'"
  else
    P1=""; P2=""
    die "Admin not created (reason above). Re-run the script to try again."
  fi
  P1=""; P2=""
fi

# ------------------------------------------------------------- 7. smoke ---
if [ "$RUN_SMOKE" = "yes" ]; then
  step "7/8  Smoke test"
  for url in http://127.0.0.1:8080/api/healthz http://127.0.0.1:5173 http://127.0.0.1:4010/__mock/health http://127.0.0.1:4020/__mock/health; do
    if curl -s -o /dev/null --max-time 1 "$url"; then
      die "Something is already answering at $url. Stop your other 'npm run dev' (Ctrl+C in its window) and re-run."
    fi
  done
  LOG="${HOME}/claru-dev-data/l1-smoke.log"; mkdir -p "$(dirname "$LOG")"
  set -m
  npm run dev > "$LOG" 2>&1 &
  DEV_PID=$!
  set +m
  cleanup_dev() { kill -TERM -- "-$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true; }
  trap cleanup_dev EXIT
  i=0; code=""
  while [ $i -lt 45 ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:5173/api/healthz || true)"
    [ "$code" = "200" ] && break
    i=$((i + 1)); sleep 1
  done
  failed=0
  expect() { # expect <label> <wanted http code> <curl args...>
    local label="$1" want="$2" got; shift 2
    got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true)"
    if [ "$got" = "$want" ]; then ok "$label → $got"; else warn "$label → ${got:-no answer} (expected $want)"; failed=1; fi
  }
  expect "health check (no sign-in needed)" 200 http://127.0.0.1:5173/api/healthz
  expect "admin list without signing in is refused" 401 http://127.0.0.1:5173/api/admin/users
  expect "sign-in without the CSRF header is refused" 403 -X POST -H 'Content-Type: application/json' -d '{"username":"x","password":"y"}' http://127.0.0.1:5173/api/auth/login
  expect "wrong password is refused" 401 -X POST -H 'Content-Type: application/json' -H 'X-Requested-With: cvu' -d '{"username":"nobody-here","password":"wrong-password-1"}' http://127.0.0.1:5173/api/auth/login
  cleanup_dev; trap - EXIT; sleep 1
  [ $failed -eq 0 ] || die "Smoke test failed. Log: $LOG"
else
  step "7/8  Smoke test (skipped)"
fi

# ---------------------------------------------------------- 8. commit ---
step "8/8  Git commit"
if [ "$L1_DONE" = "yes" ]; then
  ok "L1 already committed ($(git log -1 --grep='^L1:' --pretty='%h')) — nothing committed"
elif [ -z "$(git config user.name || true)" ] || [ -z "$(git config user.email || true)" ]; then
  warn "Git has no name/email; commit yourself: git add -A && git commit -m \"L1: login, users and roles\""
else
  git add -A
  STAGED="$(git diff --cached --name-only)"
  case "$(printf '%s\n' "$STAGED" | grep -E '(^|/)\.env$' || true)" in ?*) die ".env was about to be committed — aborting." ;; esac
  git commit -q -m "L1: login, users and roles"
  ok "committed: $(git log -1 --pretty='%h %s')"
fi

printf '\n%sL1 complete.%s\n' "$G$B" "$N"
info "Run:   npm run dev   → open http://127.0.0.1:5173 and sign in as your admin"
info "Try:   Users → add a consultant → sign in as them in a private window"
info "Next:  share this output; then phase L2 (resumable upload)."