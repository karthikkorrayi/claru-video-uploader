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
