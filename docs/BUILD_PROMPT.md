# Football Predictor, Phase 1 (Backtest Lab)

Credential values are intentionally omitted. Repository: `vjumbo264/football-predictor` (public). Publisher: Actions `GITHUB_TOKEN`.

Phase 1 only: historical, chronological walk-forward evaluation in five European leagues (E0, SP1, I1, D1, F1), six completed seasons plus a separately labeled current-season slice if sufficient. Use football-data.co.uk CSVs and document data quality. No applet on hosts that do not require one; no deployment, Telegram, paid API, databases, live pipeline, heavy ML, African leagues or staking systems.

B1 scaffold and CI; B2 cached raw data, cleaning, and quality report; B3 metrics and naive and de-margined bookmaker baselines; B4 weighted Poisson and Dixon–Coles; B5 Elo and goal-based recent form; B6 chronological engine, validation search and committed freeze; B7 validation-only ensemble; B8 single held-out test; B9 validation-frozen flat-stake betting and closing-line value; B10 phone-readable report and uniquely tagged GitHub Release.

Latest two completed seasons are the official test. Use strictly earlier match dates for training and demonstrate leakage resistance. Score 1X2, O/U 2.5 and BTTS (calibration only, no bets). Compare against bookmaker on matched coverage; report log loss, Brier, accuracy, reliability, ECE and match-week bootstrap intervals. Report actual odds, ROI, hit rate, drawdown, bet counts, average odds, CLV and controls. Document comparisons tried; never tune on test. Commit and push per small verified unit, updating BUILD_STATE.json and docs/DECISIONS.md. Resume from first unfinished item. GitHub Actions runs on ubuntu-latest, Python 3.11+, under about 30 minutes. No result claims without verified artifacts.
