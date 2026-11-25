# Phase 2 Report — Premier League Telegram Predictor Bot

## Summary
Phase 2 deploys the frozen Phase 1 ensemble (`dixon_coles`, `elo`, `poisson`, `form`) into a production Telegram bot (`@ScripturaMotionsaltBot`) backed by Cloudflare Workers, Cloudflare D1, and GitHub Actions.

## Architecture & Endpoints
- **Worker:** `https://football-predictor.vjumbo264.workers.dev`
- **D1 Database:** `football-predictor-db` (`b58e8adf-3ed5-4b3f-bc1f-2336ad1b7e4d`)
- **Daily Job:** `.github/workflows/daily-predict.yml` (`05:00 UTC` daily + manual `workflow_dispatch`)
- **Cron Grading:** `*/20 * * * *` (no-ops at 0 external calls when nothing is due)

## Empirical Data Source Findings
- **API-Football free plan (`FOOTBALL_API_KEY`):** Blocks `season=2026`, `last=N`, and `date` outside `today ± 1 day`. Live endpoint (`/fixtures?league=39&live=all`) works for 2026 matches. Used for `/live` with a 60s D1 cache and hard 80/day budget guard.
- **Official FPL API (`fantasy.premierleague.com/api/`):** Free, unauthenticated, returns all 380 2026/27 Premier League fixtures, kickoffs, live/finished status, and scores. Used as primary schedule and grading source (0 API-Football quota).
- **`football-data.co.uk` CSVs:** Runtime-cached historical seasons (`2020/21`–`2026/27/E0.csv`) for refitting `footpred` models.

## Integrity Guarantees
- `predictions` table is strictly insert-only (`UNIQUE(match_id, model_version)`, `INSERT OR IGNORE`, pre-kickoff validation rejecting started matches with HTTP 400, and SQLite `BEFORE UPDATE` / `BEFORE DELETE` triggers).
- `prediction_results` table is strictly append-only via `UNIQUE(prediction_id)` and SQLite triggers.
- Provisional estimates (`>36h` away in `/match`) are computed from cached team strengths and never stored in `predictions`.

## Verification
- Worker TypeScript typecheck & 13 unit/integration tests pass (against real SQLite schema & triggers).
- Python `pytest` suite (`footpred` + `jobs/sources` + `jobs/predict_and_ingest`) passes in GitHub Actions CI.
- Live Worker `/health`, bad-auth `/ingest` (`401`), started-match `/ingest` (`400`), webhook bad-secret (`403`), `getWebhookInfo`, live `/grade`, and idempotent real-data `daily-predict.yml` run + rerun verified against production D1.
