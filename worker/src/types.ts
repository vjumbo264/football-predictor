export interface Env {
  DB: D1Database;
  INGEST_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM_IDS: string;
  FOOTBALL_API_KEY: string;
  API_DAILY_CAP?: string;
  LIVE_CACHE_SECONDS?: string;
  CLOSE_MATCH_GAP?: string;
  DEFAULT_LEAGUE?: string;
}

export type MatchStatus = 'NS' | 'LIVE' | 'FT' | 'PST';
export type Outcome = 'H' | 'D' | 'A';

export interface IngestTeam {
  canonical_name: string;
  display_name: string;
  short_name?: string | null;
  aliases: string[];
}

export interface IngestModelVersion {
  model_version: string;
  config_hash: string;
  description?: string | null;
}

export interface IngestFixture {
  match_id: string;
  league: string;
  season: number;
  home_team: string;
  away_team: string;
  home_display: string;
  away_display: string;
  kickoff_utc: string;
  status: MatchStatus;
  provider?: string | null;
  provider_id?: string | null;
}

export interface IngestPrediction {
  match_id: string;
  model_version: string;
  config_hash: string;
  kickoff_utc: string;
  p_home: number;
  p_draw: number;
  p_away: number;
  p_over25?: number | null;
  p_btts?: number | null;
  xg_home?: number | null;
  xg_away?: number | null;
  predicted_outcome: Outcome;
  summary_reason?: string | null;
}

export interface IngestResult {
  match_id: string;
  home_goals: number;
  away_goals: number;
  actual_outcome: Outcome;
  status?: 'FT';
  source: string;
}

export interface IngestPayload {
  model_version?: IngestModelVersion;
  teams?: IngestTeam[];
  fixtures?: IngestFixture[];
  predictions?: IngestPrediction[];
  results?: IngestResult[];
}
