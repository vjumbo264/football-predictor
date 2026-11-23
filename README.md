# Football Predictor — Phase 1 Backtest Lab

**Status: historical experiment blocked on data-use permission.** No historical test data, result, betting verdict, or official release has been published. GitHub Actions verifies the code with synthetic fixtures. See [build state](BUILD_STATE.json) and [data quality](results/data_quality.md).

The lab compares league frequencies, power and proportional bookmaker probabilities, Poisson, Dixon–Coles, Elo, recent form, and a validation-weighted ensemble. Markets: 1X2, Over/Under 2.5, and calibration-only BTTS. The model API is `fit(history, cutoff)` and `predict(home, away)`; use one model instance per league. Refits use only dates before the cutoff. See [design decisions](docs/DECISIONS.md).

## Run from GitHub on a phone

1. Open **Actions → Backtest Lab → Run workflow** on `main`. `smoke` tests synthetic data; it cannot create a release or inspect the holdout.
2. **Only after input/publication permission is verified**, an authorized maintainer can add immutable five-league CSVs as `data/raw/<SSYY>/<league>.csv`. This directory is intentionally ignored by default. Begin with `2021` through `2324`, not the holdout. Use `validate` with authorization checked. It refuses to freeze without both odds markets; it does not read holdout files.
3. Review the validation artifact; commit its `frozen_config.json`, `search_log.csv`, `betting_search_log.csv`, `validation_metrics.json`, and data quality report into `results/` on `main`. Record permissions, file checksums and data exceptions. Do not alter `footpred/` after the freeze; any code change requires a new validation freeze **before** the official holdout is viewed.
4. Supply the authorized `2425` and `2526` snapshots only after committing the freeze. Run `official` with that exact 40-character freeze commit and authorization checked. It claims a one-time tag, runs the two held-out seasons, commits aggregate results, and publishes a unique `phase1-<run-number>` release with the report and plots. It may add a separate 2026/27 forward result if all five leagues have at least 50 matches. Missing odds do not get filled. Test forecasts use rolling past results, but the frozen settings never move.
5. If release publication fails after official results were committed, use `publish` to release the existing results without rescoring. If an official run failed after claiming the lock but before committing results, record the failure and inspect whether test data were exposed; never silently delete the lock or retune. Any correction after test exposure must be prominently recorded as such. Confirm the green run and attached release, then update `BUILD_STATE.json`.

The all-season bookmaker baseline audit is descriptive and runs only after the official freeze. No live prediction front-end, wagering integrations, or deployment is included.
