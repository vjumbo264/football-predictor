# Fix Round 3 UX & Identity Report — Football Predictor

## What Changed

- **K1 — Clean Identity & Commands (`scripts/setup_bot_profile.mjs`, `assets/avatar.png`):**
  - Replaced `TELEGRAM_BOT_TOKEN` with the new `@MotionsaltFootballBot` token in both GitHub Actions and Cloudflare Worker secrets, and configured `ADMIN_TELEGRAM_IDS`.
  - Cleared legacy command scopes (`default`, `all_private_chats`, `all_group_chats`, `all_chat_administrators`, `en`) and registered the 8 clean commands: `/menu`, `/today`, `/tomorrow`, `/match`, `/live`, `/results`, `/performance`, `/help`.
  - Set display name (`Football Predictor`), description, short description, `commands` chat menu button, and uploaded the original 640×640 `assets/avatar.png` profile photo directly via `setMyProfilePhoto`.
  - Automated profile + webhook setup (`allowed_updates: ["message", "edited_message", "callback_query"]`) in `.github/workflows/deploy-worker.yml`.
- **K2 — Button-Driven Main Menu (`worker/src/telegram.ts`):**
  - `/menu` and returning `/start` open the inline Main Menu (**Today**, **Tomorrow**, **Live**, **Results**, **Performance**, **Find a match**, **How to use**).
  - Inline taps edit the existing message in place (`editMessageText`), always call `answerCallbackQuery`, include **Back** and **Home** buttons on every screen, ignore taps from unapproved users, and fall back to `sendMessage` on `"message is not modified"` and `"message to edit not found"`.
- **K3 — Paginated Match Lists & Detail View (`worker/src/commands_schedule.ts`):**
  - `/today` and `/tomorrow` display matches as buttons (`17:30 Arsenal v Chelsea`), paginated at 8 per page with **Previous** / **Next** and **Prev day** / **Next day** arrows.
  - Tapping a match opens full probabilities, expected goals, form, head-to-head, plain-language reason, close-match marker, and live/final status with **Refresh**, **Back to list**, and **Home**.
- **K4 — Team Grid Match Finder (`worker/src/teams.ts`, `worker/src/commands_schedule.ts`):**
  - "Find a match" renders the 20 current Premier League teams in a 3-per-row alphabetical short-name grid (`ARS`–`TOT`).
  - Tapping a team shows its next fixture with prediction (or `[PROVISIONAL]` / none-scheduled message) and last 5 results, while `/match <team>` and plain-text nicknames (`Man U`, `Spurs`, `Forest`) continue to work.
- **K5 — Quick Keyboard & Plain-Language Onboarding (`worker/src/telegram.ts`):**
  - Added a 1-row persistent reply keyboard (**Today**, **Live**, **Results**, **Menu**).
  - First-time `/start` (tracked via `users.onboarded_at`) shows a 2-page plain-language intro covering 1X2 percentages, `Close match, draw risk`, pre-kickoff locking, honest 50–55% accuracy, `/performance`, and risk disclaimer.
- **K6 — Telegram Admin & Approval Flow (`worker/migrations/0002_ux_and_admin.sql`, `worker/src/admin.ts`, `worker/src/auth.ts`):**
  - Added `allowed_users` and `access_requests` D1 tables merged with `ALLOWED_TELEGRAM_IDS` and `ADMIN_TELEGRAM_IDS`.
  - Unapproved users receive a single private-bot message (at most once per 24h) and trigger one automatic admin notification with **Approve** / **Decline** buttons.
  - Added admin-only `/adduser`, `/removeuser`, `/users`, and `/pending` commands, with forged-callback rejection for non-admins.

## Verification

- Worker TypeScript check (`tsc --noEmit`) and 21/21 automated SQLite-backed unit & webhook simulation tests pass (`menus_callbacks`, `day_pagination_detail`, `team_grid`, `onboarding_keyboard`, `admin_approval`, `telegram`, `schedule_commands`, `live_results`, `grading_performance`, `ingest`, `morning_digest`, `e2e_commands`).
- Live Cloudflare Worker deployed with D1 migration `0002_ux_and_admin.sql`, `setWebhook` active, and Bot API getters (`getMe`, `getMyName`, `getMyCommands`, `getMyDescription`, `getMyShortDescription`, `getChatMenuButton`, `getWebhookInfo`) verified.
