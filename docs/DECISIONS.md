# Decisions

- This host does not require an applet; no front-end was created.
- The build brief in the repo is summarized and contains no credential values.
- Data access: no raw/public archival until upstream permission and suitable coverage are verified. The DataHub candidate has downstream PDDL but does not establish the required scope of prices or upstream permission; Kaggle and Footiqo did not establish a free exact replacement. Immutable authorized inputs can be parsed from disk; raw inputs and local run outputs are ignored by git.
- Chronological split: 2020/21–2022/23 burn-in, 2023/24 validation, 2024/25–2025/26 test, 2026/27 forward slice only if eligible. No observed test results were inspected.
- Prefer reliable Pinnacle for benchmarks; from 23 July 2025 exclude it per the provider's warning. Market average is a benchmark, not an executable price; simulation uses predefined named-book order with the same book's close, leaving missing close missing.
- One-vs-rest ECE averages across classes; Brier sums over classes for 1X2 and binary markets. Confidence intervals resample whole calendar weeks with all paired rows retained.
