# Football Predictor (Premier League Win/Draw/Loss Bot)

A private Telegram bot (`@ScripturaMotionsaltBot`) that delivers honest Premier League match outcome probabilities (Home Win / Draw / Away Win), live scores, settled results, and a transparent calibration & accuracy track record.

- **Phase 1 (Backtest Lab):** Historical walk-forward evaluation (`footpred/`, `results/REPORT.md`, `results/frozen_config.json`, Release `phase1-real-6`). Established that the ensemble matches bookmaker-level calibration without beating the margin, so Phase 2 is strictly an honest probability viewer — **no odds, stakes, or betting tips**.
- **Phase 2 (Production Bot):** Cloudflare Worker + Cloudflare D1 + GitHub Actions daily Python model refit & ingest.

---

## How It Works

1. **Daily Python Job (`.github/workflows/daily-predict.yml`, ~05:00 UTC + manual trigger):**
   - Fetches and caches historical Premier League (`E0`) CSVs from `football-data.co.uk` (2020/21–2026/27, never committed) plus completed 2026/27 matches from the official Fantasy Premier League (FPL) API.
   - Refits the Phase 1 frozen ensemble (`dixon_coles`, `elo`, `poisson`, `form` using `results/frozen_config.json`).
   - Generates locked 1X2 probabilities for Premier League fixtures kicking off within the next **36 hours** that have no existing prediction yet, plus a 14-day schedule & team-strength snapshot.
   - POSTs fixtures, recent results, and predictions to the Worker `/ingest` endpoint (`Authorization: Bearer <INGEST_SECRET>`).

2. **Cloudflare Worker (`worker/` + Cloudflare D1 `football-predictor-db`):**
   - **Prediction integrity:** `predictions` is strictly **insert-only** (enforced by pre-kickoff validation in `/ingest`, `UNIQUE(match_id, model_version)`, `INSERT OR IGNORE`, and SQLite `BEFORE UPDATE` / `BEFORE DELETE` triggers). Predictions for started matches are rejected with HTTP 400.
   - **Telegram Webhook (`/telegram/webhook`):** Verifies `X-Telegram-Bot-Api-Secret-Token` and restricts access to numeric IDs in `ALLOWED_TELEGRAM_IDS`. Unlisted users receive their numeric ID.
   - **Cron Grading (`*/20 * * * *`):** No-ops with zero external calls when no ungraded match is past kickoff + 105 minutes; otherwise fetches finished scores (FPL primary at 0 API-Football quota, API-Football date fallback), records `results`, and appends immutable `prediction_results` (hit/miss, Brier score, log loss).

---

## Bot Commands (Lagos Time, WAT / UTC+1)

- `/start`, `/help` — Overview, command list, and honest accuracy note (top-flight 1X2 accuracy is ~50–55%).
- `/today` — Today's Premier League matches in WAT, predicted outcome, 1X2 percentages, and close-match warning (`⚖️ Close match, draw risk` when top two outcomes are within 8 percentage points).
- `/tomorrow` — Tomorrow's Premier League matches in WAT.
- `/match <team>` or `/match <home> vs <away>` — Probabilities, expected goals, last-5 form, last-5 head-to-head, and one-line explanation. Supports nicknames (`Man U`, `Spurs`, `Forest`). Fixtures >36h away show an unstored `[PROVISIONAL]` estimate.
- `/live` — Live Premier League scores & minutes paired with locked pre-match predictions (60s D1 cache, 80/day API-Football cap with FPL fallback).
- `/results` — Recent finished matches with final score and ✅ Hit / ❌ Miss.
- `/performance` — Overall, 7-day, and 30-day accuracy vs always-picking-home baseline, mean Brier score, mean log loss, and confidence calibration buckets.

---

## How to Rerun or Deploy

- **Trigger daily predictions manually:** GitHub Actions → **Daily Premier League Predictions** → **Run workflow** (optional `window_hours` input, default `36`).
- **Deploy Worker manually:** GitHub Actions → **Deploy Cloudflare Worker** → **Run workflow**, or locally from `worker/`:
  ```bash
  npm ci && npm run typecheck && npm test
  npx wrangler d1 migrations apply football-predictor-db --remote
  npx wrangler deploy
  ```
- **Run tests locally:**
  - Python: `python -m pytest -q`
  - Worker: `cd worker && npm test`

---

## Secrets Reference (Names Only)

Configure these as **GitHub Actions secrets** and/or **Cloudflare Worker secrets** (`wrangler secret put`):

- `CLOUDFLARE_API_TOKEN` (GitHub Actions)
- `CLOUDFLARE_ACCOUNT_ID` (GitHub Actions)
- `WORKER_URL` (GitHub Actions)
- `INGEST_SECRET` (GitHub Actions + Worker)
- `TELEGRAM_BOT_TOKEN` (GitHub Actions + Worker)
- `TELEGRAM_WEBHOOK_SECRET` (GitHub Actions + Worker)
- `ALLOWED_TELEGRAM_IDS` (GitHub Actions/reference + Worker)
- `FOOTBALL_API_KEY` (Worker)
- `FOOTBALL_DATA_CACHE_KEY` (Phase 1 Actions cache)

---

## Adding a User to `ALLOWED_TELEGRAM_IDS`

1. Have the user message the bot once — it replies with their numeric Telegram ID (e.g. `123456789`).
2. Update the `ALLOWED_TELEGRAM_IDS` secret as a comma-separated list (e.g. `6339561761,123456789`) on the Cloudflare Worker:
   ```bash
   cd worker
   npx wrangler secret put ALLOWED_TELEGRAM_IDS
   ```
   (And update the `ALLOWED_TELEGRAM_IDS` GitHub Actions secret for consistency.)

---

## Adding Another League Later

1. Add a `LeagueConfig` entry in `jobs/config.py` (e.g. `'SP1'` for La Liga with `api_football_id=140`, `fpl_enabled=False`, `timezone='Africa/Lagos'`).
2. Add club aliases/display names for that league in `jobs/teams.py` and `worker/src/teams.ts`.
3. Run `python -m jobs.predict_and_ingest --league SP1` (or extend the matrix in `.github/workflows/daily-predict.yml`).
4. Parameterize `DEFAULT_LEAGUE` or pass a league filter in the Worker D1 queries (all tables already store `league`).
