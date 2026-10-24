-- Phase L3: media checks, cutting into clips, and the per-clip declaration.

ALTER TABLE recordings
  ADD COLUMN check_status   text CHECK (check_status IN ('pending', 'running', 'passed', 'warned', 'failed')),
  ADD COLUMN check_problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN media          jsonb,
  ADD COLUMN checked_at     timestamptz,
  ADD COLUMN split_status   text CHECK (split_status IN ('pending', 'running', 'done', 'failed')),
  ADD COLUMN split_error    text,
  -- Declaration (claru-integration.md, "What you declare with each clip").
  -- collectorId is not stored: it is always the uploader's username.
  ADD COLUMN category_code  text,
  ADD COLUMN country        text CHECK (country ~ '^[A-Z]{2}$'),
  ADD COLUMN site_id        text,
  ADD COLUMN device         text,
  ADD COLUMN mount          text,
  ADD COLUMN recorded_at    timestamptz,
  ADD COLUMN consent        jsonb,
  ADD COLUMN batch_ref      text,
  ADD COLUMN declared_at    timestamptz,
  ADD COLUMN declared_by    uuid REFERENCES users (id);

-- One row per clip Claru will receive. A recording up to 30 minutes is one clip
-- (a hard link to the original, no copy); a longer one is cut into equal parts.
CREATE TABLE clips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id     uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  seq              int NOT NULL CHECK (seq >= 1),
  start_seconds    numeric(10, 3) NOT NULL CHECK (start_seconds >= 0),
  duration_seconds numeric(10, 3) NOT NULL CHECK (duration_seconds > 0),
  path             text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  -- Claru's idempotency key for this clip; never reused for different footage.
  external_ref     text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, seq)
);

-- Background work (checks, splitting; delivery from L4). One open job per kind
-- and recording. A job left 'running' by a stopped server is re-queued at start-up.
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('check', 'split')),
  recording_id uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE UNIQUE INDEX jobs_one_open_idx ON jobs (kind, recording_id) WHERE state IN ('queued', 'running');
CREATE INDEX jobs_due_idx ON jobs (run_after, id) WHERE state = 'queued';
