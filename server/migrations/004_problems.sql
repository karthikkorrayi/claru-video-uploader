-- Deployment (D1): errors worth investigating, from the server, background jobs
-- and testers' browsers, readable by the admin without logging in to the server.
-- Full logs stay in journald on the server; this is the short list. Kept 30 days.

CREATE TABLE problems (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL CHECK (source IN ('server', 'job', 'browser')),
  message     text NOT NULL CHECK (char_length(message) <= 1000),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  request_id  text,
  page        text
);
CREATE INDEX problems_at_idx ON problems (at DESC);
