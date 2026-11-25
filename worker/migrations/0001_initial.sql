-- Phase 2 D1 Schema: Premier League Predictor Bot
-- Enforces insert-only predictions and append-only grading at both schema and trigger levels.

CREATE TABLE IF NOT EXISTS teams (
  canonical_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  short_name TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_versions (
  model_version TEXT PRIMARY KEY,
  config_hash TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fixtures (
  match_id TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  season INTEGER NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_display TEXT NOT NULL,
  away_display TEXT NOT NULL,
  kickoff_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NS' CHECK (status IN ('NS', 'LIVE', 'FT', 'PST')),
  provider TEXT,
  provider_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fixtures_league_kickoff ON fixtures(league, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_status_kickoff ON fixtures(status, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_teams ON fixtures(home_team, away_team);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES fixtures(match_id),
  model_version TEXT NOT NULL REFERENCES model_versions(model_version),
  config_hash TEXT NOT NULL,
  kickoff_utc TEXT NOT NULL,
  p_home REAL NOT NULL CHECK (p_home >= 0.0 AND p_home <= 1.0),
  p_draw REAL NOT NULL CHECK (p_draw >= 0.0 AND p_draw <= 1.0),
  p_away REAL NOT NULL CHECK (p_away >= 0.0 AND p_away <= 1.0),
  p_over25 REAL,
  p_btts REAL,
  xg_home REAL,
  xg_away REAL,
  predicted_outcome TEXT NOT NULL CHECK (predicted_outcome IN ('H', 'D', 'A')),
  summary_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (match_id, model_version)
);

CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions(match_id, id DESC);

CREATE TRIGGER IF NOT EXISTS predictions_no_update
BEFORE UPDATE ON predictions
BEGIN
  SELECT RAISE(ABORT, 'predictions are insert-only and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS predictions_no_delete
BEFORE DELETE ON predictions
BEGIN
  SELECT RAISE(ABORT, 'predictions are insert-only and cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY REFERENCES fixtures(match_id),
  home_goals INTEGER NOT NULL CHECK (home_goals >= 0),
  away_goals INTEGER NOT NULL CHECK (away_goals >= 0),
  actual_outcome TEXT NOT NULL CHECK (actual_outcome IN ('H', 'D', 'A')),
  status TEXT NOT NULL DEFAULT 'FT' CHECK (status IN ('FT')),
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id INTEGER NOT NULL UNIQUE REFERENCES predictions(id),
  match_id TEXT NOT NULL REFERENCES fixtures(match_id),
  predicted_outcome TEXT NOT NULL CHECK (predicted_outcome IN ('H', 'D', 'A')),
  actual_outcome TEXT NOT NULL CHECK (actual_outcome IN ('H', 'D', 'A')),
  is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  brier_score REAL NOT NULL,
  log_loss REAL NOT NULL,
  graded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prediction_results_graded_at ON prediction_results(graded_at);
CREATE INDEX IF NOT EXISTS idx_prediction_results_match ON prediction_results(match_id);

CREATE TRIGGER IF NOT EXISTS prediction_results_no_update
BEFORE UPDATE ON prediction_results
BEGIN
  SELECT RAISE(ABORT, 'prediction_results are append-only and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS prediction_results_no_delete
BEFORE DELETE ON prediction_results
BEGIN
  SELECT RAISE(ABORT, 'prediction_results are append-only and cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS api_usage (
  usage_date TEXT NOT NULL,
  provider TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, provider)
);

CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  is_allowed INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  last_morning_date TEXT
);

CREATE TABLE IF NOT EXISTS live_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
