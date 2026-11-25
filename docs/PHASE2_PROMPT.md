# BUILD PROMPT: Football Predictor, Phase 2 (Premier League win/draw/loss bot)

## STEP 0: CREDENTIALS

Credential values are intentionally omitted from the public repository.
Expected secret names:
- `GITHUB_OWNER`, `GITHUB_PAT`
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- `TELEGRAM_BOT_TOKEN`
- `FOOTBALL_API_KEY`
- `ALLOWED_TELEGRAM_IDS`
- `INGEST_SECRET`, `TELEGRAM_WEBHOOK_SECRET`

## 1. ROLE AND AUTONOMY
Full autonomy. Log ambiguous defaults in `BUILD_STATE.json` (`decisions`) and `docs/DECISIONS.md`.

## 2. PROJECT BACKGROUND
Telegram bot predicting Premier League match results (home win / draw / away win) for Victor's friend. Honest probabilities, live scores, graded results, running performance. No odds, correct scores, value bets, bankers, locks, or betting tips. Reuse `footpred` and `results/frozen_config.json`.

## 3. SCOPE
- Premier League only (config-driven so adding leagues later is a config change).
- 1X2 probabilities for each fixture (optional O/U 2.5 / BTTS if cheap).
- Pre-kickoff predictions, live scores, graded results, running performance via Telegram bot.

## 4. DATA SOURCES
- Primary: API-Football free plan (`FOOTBALL_API_KEY`) verified empirically and documented in `docs/DATA_SOURCES.md`.
- Fallbacks: football-data.org free tier (`PL`) and football-data.co.uk `fixtures.csv` / season CSVs.
- Historical training: `footpred` football-data.co.uk CSVs fetched at runtime, cached, never committed.
- API budget: hard cap of 80 calls/day tracked in D1, aggressive caching, graceful cached fallback.

## 5. ARCHITECTURE
- Cloudflare Worker (`worker/`): Telegram webhook, commands, D1 reads, `/ingest`, cron result grading.
- Cloudflare D1: `fixtures`, `predictions`, `results`, `prediction_results`, `teams`, `api_usage`, `users`, `model_versions`.
- GitHub Actions (`jobs/`): daily scheduled workflow (~05:00 UTC + `workflow_dispatch`) to refit models, predict Premier League fixtures kicking off within 36 hours without an existing prediction, and POST fixtures (next 7 days) + predictions to `/ingest`.
- Prediction integrity: insert-only before kickoff; unique on match + model_version; reject started matches; grade separately via append-only `prediction_results`.

## 6. TELEGRAM BOT
- Allowlist via `ALLOWED_TELEGRAM_IDS` (unlisted users receive their numeric ID).
- Webhook secret token verification.
- Commands (HTML parse mode, Lagos time UTC+1): `/start`, `/help`, `/today`, `/tomorrow`, `/match`, `/live`, `/results`, `/performance`.

## 10. QUEUE
- P1: Data source check and `docs/DATA_SOURCES.md`
- P2: D1 schema and Worker skeleton
- P3: Daily prediction job (Python)
- P4: Telegram webhook and access control
- P5: `/today`, `/tomorrow`, `/match`
- P6: `/live` and `/results`
- P7: Result grading and `/performance`
- P8: End-to-end verification, docs, and GitHub Release
- P9: Optional daily morning message (only after P8)
