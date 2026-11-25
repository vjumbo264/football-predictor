-- Fix Round 3: onboarding state, D1-backed allowed_users, and approval workflow.

ALTER TABLE users ADD COLUMN onboarded_at TEXT;

CREATE TABLE IF NOT EXISTS allowed_users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  added_by TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_requests (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  requested_at TEXT NOT NULL,
  last_notified_user_at TEXT,
  admin_notified_at TEXT,
  decided_by TEXT,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status, requested_at);
