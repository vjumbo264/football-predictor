# FIX ROUND 3: Football Predictor bot, button-driven menus, new commands, new identity

## STEP 0: CREDENTIALS (read first)

```
GITHUB_OWNER          = <PASTE_GITHUB_OWNER>
GITHUB_PAT            = <PASTE_GITHUB_PAT>
CLOUDFLARE_API_TOKEN  = <PASTE_CLOUDFLARE_API_TOKEN>
CLOUDFLARE_ACCOUNT_ID = <PASTE_CLOUDFLARE_ACCOUNT_ID>
TELEGRAM_BOT_TOKEN    = <PASTE_TELEGRAM_BOT_TOKEN>
ADMIN_TELEGRAM_IDS    = <PASTE_ADMIN_TELEGRAM_IDS>
BOT_DISPLAY_NAME      = Football Predictor
```

Credential values are intentionally omitted from the public repository.
Secrets are stored only as GitHub Actions secrets and Cloudflare Worker secrets.

## 1. ROLE AND AUTONOMY

Full autonomy. Log ambiguous defaults in `BUILD_STATE.json` (`decisions`) and `docs/DECISIONS.md`.

## 2. BACKGROUND

Repo `vjumbo264/football-predictor`: Premier League Telegram win/draw/loss prediction bot on Cloudflare Workers + D1 + daily Python GitHub Actions job. Never output odds, tips, stakes, or "sure bet" language; predictions stay insert-only and are never edited; keep the Premier League scope and honest accuracy framing (~50–55%, draws rarely the top pick).

## 3. QUEUE

- **K1:** Clean slate for commands, name, descriptions and picture (repeatable `scripts/setup_bot_profile.*` or Worker admin route, `setWebhook` with secret token, `assets/avatar.png`).
- **K2:** Main menu with inline buttons (`/start`, `/menu`, `editMessageText`, Home/Back buttons, `callback_query` handling & error fallbacks).
- **K3:** Match lists and match detail as buttons (`/today`, `/tomorrow`, 8-per-page pagination, Previous/Next day arrows, Refresh / Back to list / Home).
- **K4:** Find a match without typing (20 PL teams in 3-per-row alphabetical short-name grid, team next fixture + last 5 results, `/match <team>` and plain-text alias support kept).
- **K5:** Quick-access reply keyboard (`Today`, `Live`, `Results`, `Menu`) and plain-language first-time onboarding + "How to use".
- **K6:** Admin tools (`allowed_users` table in D1 merged with `ALLOWED_TELEGRAM_IDS`, `ADMIN_TELEGRAM_IDS`, `/adduser`, `/removeuser`, `/users`, `/pending`, automatic admin notification with Approve/Decline buttons and 24h anti-spam throttling).
- **K7:** Verification, docs and Release (`README.md`, `docs/UX_REPORT.md`, GitHub Release with `assets/avatar.png`).
