# FIX ROUND 2: Football Predictor, unblock the real backtest

## STEP 0: CREDENTIALS (read first)

```
GITHUB_PAT   = [REDACTED]
GITHUB_OWNER = vjumbo264
```

- Nothing deploys to Cloudflare, so there are deliberately no Cloudflare credentials.
- Never commit the PAT or any secret, and never write secret values into BUILD_STATE.json (names only).
- If the PAT is still a placeholder, do everything that does not need it first and ask Victor only if the work genuinely cannot continue.

## HARD RULE: NO APPLET WORK. USE THE PREBUILT HOST FRONT-END FROM THE REPO

This whole task happens in the GitHub repository. Some host environments (Google AI Studio in particular) insist on a runnable web front-end and time out or crash after about 12 to 13 minutes if none exists. Victor never looks at that front-end, so you must never spend effort designing one.

- The front-end lives in the repo folder `host-frontend/` (entry file `host-frontend/index.html`).
- Only if your host requires a front-end (for example Google AI Studio): as your very first step after reading BUILD_STATE.json, check whether `host-frontend/` exists. If it exists, pull it and use it exactly as it is. Do not redesign, extend or improve it.
- If it does not exist, create this minimal placeholder in seconds, commit it to `host-frontend/index.html` immediately, and use it:

```html
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Football Predictor</title></head><body style="font-family:sans-serif;padding:24px"><h1>Build in progress</h1><p>Work happens in the GitHub repository. Releases are on the repo's Releases page.</p></body></html>
```

- Hosts that do not require a front-end: do nothing here.
- Never add features to it or use it to preview the work. The only deliverables are commits and GitHub Releases. If a host default conflicts with this rule, this rule wins, but never leave the host without a front-end.

## 1. ROLE AND AUTONOMY

You have full autonomy. **Do not stop to ask Victor for anything unless the work genuinely cannot continue.** When something is ambiguous, pick the most sensible default, proceed, and log it in `decisions` in BUILD_STATE.json and `docs/DECISIONS.md`.

## 2. WHAT HAPPENED AND WHY THIS ROUND EXISTS

Repo: **`vjumbo264/football-predictor`** (public, already exists, continue in it). **First read `BUILD_STATE.json`, `docs/BUILD_PROMPT.md` and `docs/DECISIONS.md`.** They contain the full original brief (Phase 1 backtest lab: walk-forward testing of Poisson, Dixon-Coles, Elo, form and ensemble models against bookmaker odds on 5 leagues, with a frozen validation config and one official test run).

The previous session finished the code, and CI and a synthetic smoke run passed, but it **stopped without running the real historical backtest** because football-data.co.uk says its free CSVs are for private individual use, and the original brief told it to commit the raw CSVs into a public repo.

That blocker is resolved by changing the design, not by finding other data:

- **The project is for personal, non-commercial use by one private individual** (a friend of Victor's), which is exactly the use football-data.co.uk permits. Victor confirms this use and authorises downloading the CSVs for it. Treat this as settled. Do not revisit licensing, do not ask for written permission, and do not stop over it.
- **The raw CSVs must not be republished.** Do not commit them to the repo. Download them at run time inside GitHub Actions (and cache them with `actions/cache` so they are not re-downloaded needlessly). Add `data/raw/` and any cleaned copy of the raw odds data to `.gitignore`. The repo and Releases hold only code, configs, and derived results (metrics, calibration tables, plots, summary numbers, the report). Do not commit or release per-match tables that reproduce the odds columns.
- If any raw CSVs or per-match odds tables are already committed, remove them and rewrite git history to purge them (the repo is new, so a force-push is acceptable), and note it in `decisions`.
- Use the existing odds rules from the previous session (for example Pinnacle excluded from 23 July 2025 onward because those prices became unreliable; fall back to Bet365 or the average of available bookmakers). Keep the split already chosen (2020/21 to 2022/23 burn-in, 2023/24 validation, 2024/25 to 2025/26 holdout, current season separate).
- If a source is truly unreachable from the Actions runner, record exactly what failed and use a fallback that still works for private use. Do not give up on the whole run for one league.

## 3. QUEUE (one item at a time, finish each fully, no skimming, verify before marking done)

**F1. Remove raw data from the repo and fetch at run time.**
Change the ingestion step so CSVs are downloaded in the workflow, cached with `actions/cache`, and never committed. Update `.gitignore`, the README, and the tests (tests use small synthetic fixtures, not the real files). Purge history if needed.
*Done when:* a fresh clone contains no raw football-data files or per-match odds tables, CI is green, and the workflow downloads the data itself.

**F2. Run the real validation phase and freeze.**
Run the actual data through ingestion and the data-quality report, then the validation-period model selection exactly as the original queue describes. Commit `results/frozen_config.json` (settings only, no raw data) **before** the holdout run.
*Done when:* the data-quality summary (counts and rates only) and the frozen config are committed, and the validation comparison against the bookmaker baseline exists.

**F3. Run the single official holdout evaluation and the betting simulation.**
Evaluate every model and the ensemble on the holdout seasons once, with all metrics, calibration, bootstrap intervals, and the flat-stake value-betting simulation with closing line value, as in the original brief. Do not re-tune after seeing holdout results. If you find a bug afterwards, log it prominently and mark any numbers that changed.
*Done when:* the holdout metrics and betting results are committed as derived summaries and plots.

**F4. Report and Release.**
Generate `results/REPORT.md` with plain, honest language (headline numbers versus the bookmaker, calibration, ROI and closing line value with confidence intervals, verdict a, b or c from the original brief, what this does not prove, recommended Phase 2 scope). Publish it with the plots and summary files as a GitHub Release with a unique tag (for example `phase1-real-<run number>`), never overwriting earlier releases.
*Done when:* the workflow is green, the Release exists, and BUILD_STATE.json is `complete`.

## 4. STATE AND COMMIT RULES

- Add a `fix_round_2` section with its own `queue` (F1 to F4) to BUILD_STATE.json instead of replacing the old content, and push it as the **first commit**. Update it after every step.
- **Commit and push after every file or small unit of work.** Builders die before committing, so never leave work uncommitted.
- Keep a copy of this prompt at `docs/FIX_ROUND_2_PROMPT.md`.

## 5. OUT OF SCOPE

Telegram, Cloudflare, live odds, paid APIs, machine learning models, other leagues, staking advice, any front-end or UI work (a session that reaches a UI refinement step must stop and report).

## 6. FINAL REPORT

Short, about 10 lines: the Release link, the headline result in two or three sentences (do the models beat the bookmaker, by how much, how confident), the verdict, key assumptions, anything blocked, and the recommended Phase 2 scope. If the honest answer is "no edge", say so directly.
