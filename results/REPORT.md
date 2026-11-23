# Phase 1 Backtest Lab

## What we tested

Five European leagues. Burn-in: 2020/21–2022/23. Validation: 2023/24. Held-out test: 2024/25–2025/26.
The separately reported 2026/27 forward slice does not contribute to any holdout number below.
Models were refit every 14 days with strictly earlier data. Teams with fewer than five prior games at refit were skipped. Headline market comparisons use identical matches with complete odds. Log loss and Brier: lower is better. ECE measures calibration error; lower is better. BTTS has no odds benchmark.
Tried 21 model-parameter variants, one learned ensemble per market, and 90 betting combinations on validation. The test did not choose the settings.
Forecast benchmarks remove the margin from the best available complete market snapshot under the frozen source order. Pinnacle is excluded from 23 July 2025 onward. The betting simulation uses named-book pre-close prices, not a market-average payout.

## Forecasts

### 1X2
3,446 comparable matches of 3,446 eligible.

| Model | Log loss | Brier | ECE |
|---|---:|---:|---:|
| dixon_coles | 0.9875 | 0.5887 | 1.17% |
| elo | 0.9926 | 0.5919 | 1.38% |
| ensemble | 0.9874 | 0.5887 | 0.94% |
| form | 1.0275 | 0.6159 | 3.78% |
| league_prior | 1.0779 | 0.6524 | 1.36% |
| poisson | 0.9883 | 0.5891 | 1.67% |
| bookmaker_power | 0.9702 | 0.5773 | 1.56% |
| proportional | 0.9709 | 0.5776 | 1.40% |

Lowest observed model log loss: **ensemble** (descriptive, not a new model selection).
Ensemble minus bookmaker log loss: +0.0172 (95% week-bootstrap CI [+0.0125, +0.0221]).
Ensemble minus bookmaker Brier: +0.0114 (95% week-bootstrap CI [+0.0083, +0.0146]).

### OU25
3,446 comparable matches of 3,446 eligible.

| Model | Log loss | Brier | ECE |
|---|---:|---:|---:|
| dixon_coles | 0.6827 | 0.4896 | 3.00% |
| elo | 0.6850 | 0.4919 | 0.34% |
| ensemble | 0.6792 | 0.4864 | 1.62% |
| form | 0.6845 | 0.4914 | 1.59% |
| league_prior | 0.6897 | 0.4965 | 1.29% |
| poisson | 0.6827 | 0.4896 | 3.03% |
| bookmaker_power | 0.6732 | 0.4805 | 1.59% |
| proportional | 0.6730 | 0.4803 | 1.15% |

Lowest observed model log loss: **ensemble** (descriptive, not a new model selection).
Ensemble minus bookmaker log loss: +0.0060 (95% week-bootstrap CI [+0.0022, +0.0095]).
Ensemble minus bookmaker Brier: +0.0059 (95% week-bootstrap CI [+0.0021, +0.0092]).

### BTTS
3,446 comparable matches of 3,446 eligible.

| Model | Log loss | Brier | ECE |
|---|---:|---:|---:|
| dixon_coles | 0.6904 | 0.4970 | 3.17% |
| elo | 0.6892 | 0.4961 | 0.47% |
| ensemble | 0.6860 | 0.4929 | 1.63% |
| form | 0.6882 | 0.4950 | 2.11% |
| league_prior | 0.6893 | 0.4962 | 0.85% |
| poisson | 0.6913 | 0.4978 | 3.71% |

Lowest observed model log loss: **ensemble** (descriptive, not a new model selection).

## Flat-stake historical simulation

| Market / strategy | Bets | ROI (95% CI) | Mean CLV (95% CI) | Close matches |
|---|---:|---:|---:|---:|
| 1X2 / model | 0 | — — | — — | 0 |
| 1X2 / bet_every_outcome | 10338 | -6.30% [-7.90%, -4.56%] | -0.12% [-0.31%, 0.05%] | 10338 |
| 1X2 / bet_all_favourites | 3446 | -2.47% [-5.11%, 0.19%] | -0.50% [-0.71%, -0.28%] | 3446 |
| OU25 / model | 0 | — — | — — | 0 |
| OU25 / bet_every_outcome | 6892 | -4.12% [-4.90%, -3.33%] | -0.21% [-0.28%, -0.15%] | 6892 |
| OU25 / bet_all_favourites | 3446 | -4.59% [-7.92%, -1.20%] | -0.13% [-0.37%, 0.09%] | 3446 |

**Both markets:** No candidate met the validation activation rule. The frozen strategies placed zero bets, so their ROI and closing-line value are not estimable.


ROI uses actual decimal prices and one unit per ticket; no margin removal in payouts. CLV is posted odds divided by the same book’s closing odds, minus one. Missing closes are not imputed. Hit rate, average odds, same-book close coverage and daily drawdown are in the betting results for strategies with tickets.

## Verdict

**(a) No convincing evidence of a betting edge.** Use the calibration tables to judge whether probabilities are suitable to display. A good probability forecast need not survive the bookmaker margin.

## What this does not prove

One two-season holdout cannot establish persistent profit or live price availability. Weekly bootstrap intervals describe sampling variation, are not simultaneous across all league/market slices, and do not account for limits, timing, price changes or many exploratory comparisons. Quoted pre-close snapshots are not a guarantee of execution.

## Phase 2 scope

Start in shadow mode with probability display and calibration monitoring only, in leagues with strong coverage. Do not enable betting alerts on these results alone. Keep BTTS informational.
