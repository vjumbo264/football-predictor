# Football Predictor — Phase 1 Backtest Lab

This repository compares league frequencies and de-margined bookmaker probabilities with Poisson, Dixon–Coles, Elo, recent form and a validation-weighted ensemble across five European leagues. Markets are 1X2, Over/Under 2.5 and calibration-only BTTS. Refits use only dates before the cutoff. See [build state](BUILD_STATE.json), [data quality](results/data_quality.md) and [design decisions](docs/DECISIONS.md).

## Private-use inputs, public aggregates

The historical CSVs are obtained from [Football-Data.co.uk](https://www.football-data.co.uk/downloadm.php) at run time for the authorized private individual, non-commercial use. Do not commit or upload raw input, normalized copies or per-match odds/prediction ledgers. The public repo, Actions artifacts and Releases hold only code, settings, aggregate results and plots. Tests use generated fixtures and do not require the source or any secret. No applet, deployment, or live service is used.

## GitHub Actions workflow

1. Open **Actions → Backtest Lab → Run workflow** on `main`. `smoke` runs synthetic tests only. `ingest` checks the authorized training downloads without model scoring. Check the private-use authorization box for all historical stages.
2. `validate` restores or downloads the 2020/21–2023/24 snapshots, without fetching the holdout. The encrypted training archive is reused by `official`. Only the maintainer needs the `FOOTBALL_DATA_CACHE_KEY` repository secret; raw files are never put in the public cache in plaintext. If a league CSV endpoint fails, the workflow tries the publisher's alternate hostname and season ZIP, and records failures without printing odds. Cache refresh or key rotation requires changing the cache version; altered training bytes never pass the original freeze.
3. Commit the reviewed validation artifact's `frozen_config.json`, `search_log.csv`, `betting_search_log.csv`, `validation_metrics.json` and `data_quality_validation.md` to `results/`. Any model-code or pinned dependency change invalidates that freeze.
4. Run `official` with the exact 40-character freeze commit. Only then does the workflow fetch the 2024/25 and 2025/26 holdout and optionally 2026/27. It checks frozen input hashes and completeness before claiming a one-time tag. It runs the frozen evaluation and commits only allowlisted aggregates and plots. The optional forward slice is separate and requires 50 completed matches per league. Missing odds are not imputed.
5. Run `publish` to release the existing aggregates without rescoring. Publication uses a unique `phase1-real-<run-number>` tag. Do not delete the lock or re-tune after seeing the official results; prominently document any correction and identify results that changed. See [Releases](https://github.com/vjumbo264/football-predictor/releases).
