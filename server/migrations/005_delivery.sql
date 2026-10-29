-- Phase L4: delivering clips to Claru, following the review, the 72-hour alert.

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('check', 'split', 'deliver'));

-- One row per attempt to deliver a clip. Attempt 1 uses the clip's externalRef;
-- a clip Claru REJECTED can only be sent again under a NEW externalRef (attempt 2: "-r2").
-- A REFUSED clip is retried under the SAME externalRef, in the same row.
CREATE TABLE submissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id        uuid NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  attempt        int NOT NULL CHECK (attempt >= 1),
  external_ref   text NOT NULL UNIQUE,
  claru_id       text UNIQUE,
  -- 'pending' = not created at Claru yet; the rest are Claru's own states.
  state          text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'draft', 'processing', 'in_review', 'approved', 'rejected', 'refused', 'expired')),
  declared       jsonb,        -- exactly what was sent as "declared"
  seal           jsonb,        -- Claru's seal block (warnings, duplicateCheck)
  refusal        jsonb,        -- { code, message, remedy, at } of the last refusal
  rejection      jsonb,        -- { code, type, reason, checks }
  sealed_at      timestamptz,  -- Claru's seal.at: the 72-hour clock starts here
  decided_at     timestamptz,
  last_polled_at timestamptz,
  last_error     text,
  -- Claru answered 404 for it: no more polling or alerts; "Retry delivery" sends it again (same ref).
  lost_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clip_id, attempt)
);
CREATE INDEX submissions_open_idx ON submissions (state) WHERE state IN ('processing', 'in_review') AND lost_at IS NULL;

-- Review taking too long: an alert 72 hours after sealing, then a reminder every
-- 6 hours (one per interval, never twice), until Claru approves or rejects.
CREATE TABLE review_alerts (
  id               bigserial PRIMARY KEY,
  submission_id    uuid NOT NULL UNIQUE REFERENCES submissions (id) ON DELETE CASCADE,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  last_slot        int NOT NULL DEFAULT 0,
  notifications    int NOT NULL DEFAULT 0,
  last_notified_at timestamptz,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users (id),
  resolved_at      timestamptz
);
CREATE TABLE review_alert_events (
  alert_id bigint NOT NULL REFERENCES review_alerts (id) ON DELETE CASCADE,
  slot     int NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, slot)
);

-- Every call to Claru (and every upload to its storage), for the admin's Claru page.
-- Never holds the API key, request bodies or presigned URLs. Kept 30 days.
CREATE TABLE claru_calls (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  method        text NOT NULL,
  path          text NOT NULL,
  status        int NOT NULL,
  code          text,
  ms            int NOT NULL,
  external_ref  text,
  note          text
);
CREATE INDEX claru_calls_at_idx ON claru_calls (at DESC);
