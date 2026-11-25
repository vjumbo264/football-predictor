# Football Predictor (Premier League Win/Draw/Loss Bot)

A private, button-driven Telegram bot (`@MotionsaltFootballBot`) that delivers honest Premier League match outcome probabilities (Home Win / Draw / Away Win), live scores, settled results, and a transparent calibration & accuracy track record.

- **Phase 1 (Backtest Lab):** Historical walk-forward evaluation (`footpred/`, `results/REPORT.md`, `results/frozen_config.json`, Release `phase1-real-6`). Established that the ensemble matches bookmaker-level calibration without beating the margin, so the bot is strictly an honest probability viewer — **no odds, stakes, or betting tips**.
- **Phase 2 & Fix Round 3 (Production Bot):** Cloudflare Worker + Cloudflare D1 + GitHub Actions daily Python model refit & ingest, with phone-first inline button navigation, persistent quick-access keyboard, plain-language onboarding, and Telegram-native user approval.

---

## How the Menus & Navigation Work

- **Main Menu (`/menu` or returning `/start`):** Opens an inline button dashboard with **Today**, **Tomorrow**, **Live**, **Results**, **Performance**, **Find a match**, and **How to use**. Tapping any button edits the current message in place (`editMessageText`) and includes **Back** and **Home** buttons on every screen (with automatic fallback to a fresh message if Telegram says a message is unchanged or too old to edit).
- **Quick-Access Keyboard:** A persistent 4-button row at the bottom of the chat (**Today**, **Live**, **Results**, **Menu**) works with one tap at any time.
- **Match Lists (`/today`, `/tomorrow`):** Matches are shown in Lagos time (WAT / UTC+1) as tappable buttons (e.g. `17:30 Arsenal v Chelsea`), paginated at 8 per page with **Next** / **Previous** and **Prev day** / **Next day** arrows. Tapping a match opens full probabilities, expected goals, recent form, head-to-head, close-match marker (`⚖️ Close match, draw risk` when top two outcomes are within 8 percentage points), and live/final status, with **Refresh**, **Back to list**, and **Home** buttons.
- **Find a Match:** Opens a 3-per-row alphabetical grid of the 20 current Premier League teams using short names (`ARS` to `TOT`). Tapping a team shows its next fixture with prediction (or `[PROVISIONAL]` estimate if >36h away) and its last 5 results. Typing `/match <team>`, `/match <A> vs <B>`, or plain-text team names/nicknames (`Man U`, `Spurs`, `Forest`) also works.
- **First-Time Onboarding & `/help`:** First-time `/start` shows a short two-page plain-language guide explaining what the three percentages mean, what "Close match, draw risk" means, that predictions lock before kickoff, and that typical top-flight accuracy is roughly 50–55% (with `/performance` showing the real track record).

---

## How It Works Under the Hood

1. **Daily Python Job (`.github/workflows/daily-predict.yml`, ~05:00 UTC + manual trigger):**
   - Fetches and caches historical Premier League (`E0`) CSVs from `football-data.co.uk` (never committed) plus completed 2026/27 matches from the official Fantasy Premier League (FPL) API.
   - Refits the Phase 1 frozen ensemble (`dixon_coles`, `elo`, `poisson`, `form` using `results/frozen_config.json`).
   - Generates locked 1X2 probabilities for fixtures kicking off within **36 hours** that have no existing prediction yet, plus a 14-day schedule & team-strength snapshot.
   - POSTs fixtures, recent results, and predictions to the Worker `/ingest` endpoint (`Authorization: Bearer <INGEST_SECRET>`).
2. **Cloudflare Worker (`worker/` + Cloudflare D1 `football-predictor-db`):**
   - **Prediction integrity:** `predictions` is strictly **insert-only** (enforced by pre-kickoff validation in `/ingest`, `UNIQUE(match_id, model_version)`, `INSERT OR IGNORE`, and SQLite `BEFORE UPDATE` / `BEFORE DELETE` triggers).
   - **Telegram Webhook (`/telegram/webhook`):** Verifies `X-Telegram-Bot-Api-Secret-Token`, handles `message`, `edited_message`, and `callback_query` updates, and checks access against `ADMIN_TELEGRAM_IDS`, `ALLOWED_TELEGRAM_IDS`, and the D1 `allowed_users` table.
   - **Cron Grading (`*/20 * * * *`):** No-ops with zero external calls when no ungraded match is past kickoff + 105 minutes; otherwise fetches finished scores (FPL primary, API-Football fallback), records `results`, and appends immutable `prediction_results`.

---

## Adding or Removing Users (Admin Tools)

Admins listed in `ADMIN_TELEGRAM_IDS` can manage users directly from Telegram without a CLI:

1. **Automatic Approval Flow (Recommended):**
   - Share the bot link with your friend and ask them to open it and press **Start** (or send any message).
   - They receive a short private-bot notice (at most once per 24 hours; no spam).
   - You automatically receive a notification in your chat with their name, `@username`, numeric ID, and **Approve** / **Decline** buttons.
   - Tap **Approve** to grant access immediately (the user receives a welcome message with the quick keyboard and Main Menu). Tap **Decline** to silently ignore them.
2. **Admin Slash Commands (Hidden from Public Menu):**
   - `/pending` — List waiting access requests with **Approve** / **Decline** buttons (useful if an admin notification could not be delivered).
   - `/users` — List all approved users with **Remove** buttons for D1-managed users.
   - `/adduser <id>` — Immediately grant access to a numeric Telegram ID.
   - `/removeuser <id>` — Revoke D1 access for a numeric Telegram ID (the user is treated as a new unapproved requester if they message again).
3. **Worker Secret Fallback:**
   - `ALLOWED_TELEGRAM_IDS` (comma-separated numeric IDs) continues to work alongside the D1 `allowed_users` table.

---

## Reapplying Bot Profile, Commands, & Webhook

Bot commands, display name (`Football Predictor`), descriptions, chat menu button, profile photo (`assets/avatar.png`), and Telegram webhook are managed idempotently by `scripts/setup_bot_profile.mjs`.

- **Automatic:** `.github/workflows/deploy-worker.yml` runs `node ../scripts/setup_bot_profile.mjs` on every Worker deploy (and can be triggered manually via **Actions → Deploy Cloudflare Worker → Run workflow**).
- **Manual:**
  ```bash
  TELEGRAM_BOT_TOKEN=<token> \
  TELEGRAM_WEBHOOK_SECRET=<secret> \
  WORKER_URL=https://football-predictor.vjumbo264.workers.dev \
  BOT_DISPLAY_NAME="Football Predictor" \
  node scripts/setup_bot_profile.mjs
  ```
  Pass `--drop-pending-updates` only when clearing stale queued updates.
  Note: Telegram does not allow changing a bot's `@username` via the Bot API; changing `@MotionsaltFootballBot` requires creating a new bot in `@BotFather` and swapping `TELEGRAM_BOT_TOKEN`.

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
- `ALLOWED_TELEGRAM_IDS` (GitHub Actions + Worker)
- `ADMIN_TELEGRAM_IDS` (GitHub Actions + Worker)
- `FOOTBALL_API_KEY` (Worker)
- `FOOTBALL_DATA_CACHE_KEY` (Phase 1 Actions cache)
