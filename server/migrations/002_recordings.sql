-- Phase L2: one row per original recording a consultant uploads.
-- Only the transfer is tracked here; checks, Claru delivery, review and backup
-- get their own columns or tables in later phases.

CREATE TABLE recordings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by         uuid NOT NULL REFERENCES users (id),
  original_filename   text NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 255),
  size_bytes          bigint NOT NULL CHECK (size_bytes > 0),
  fingerprint         text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  transfer_status     text NOT NULL DEFAULT 'waiting'
                      CHECK (transfer_status IN ('waiting', 'receiving', 'received', 'abandoned', 'cancelled', 'removed', 'failed')),
  received_bytes      bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  failure_reason      text,
  storage_path        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  transfer_started_at timestamptz,
  last_progress_at    timestamptz,
  received_at         timestamptz,
  ended_at            timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recordings_owner_idx ON recordings (uploaded_by, created_at DESC);
CREATE INDEX recordings_active_idx ON recordings (transfer_status) WHERE transfer_status IN ('waiting', 'receiving');

-- The same file cannot be in flight or on the server twice. Cancelled,
-- abandoned, removed and failed rows keep their fingerprint for the record
-- but no longer block a fresh upload.
CREATE UNIQUE INDEX recordings_fingerprint_live_idx ON recordings (fingerprint)
  WHERE transfer_status IN ('waiting', 'receiving', 'received');
