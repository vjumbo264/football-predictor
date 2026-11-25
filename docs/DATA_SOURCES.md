# Data Sources — Empirical Verification (2026/27 Premier League)

Verified empirically on 2026-11-25 UTC against live endpoints using the configured credentials.

## 1. API-Football (`v3.football.api-sports.io`, `FOOTBALL_API_KEY`)

- **Account / Plan:** Free plan (`limit_day: 100` requests/day). Hard cap in our system: **80 calls/day**, tracked in D1 (`api_usage`).
- **League ID:** Premier League = `39` (`/leagues?id=39` returns `200 OK`, confirms season `2026` with `current: true`).

### Empirical endpoint results
| Endpoint | Result | Plan Restriction / Notes | Call Cost |
|---|---|---|---|
| `GET /status` | `200 OK` | Returns plan & daily `requests.current` / `limit_day`. | 0 quota (per observed `/status` counter) |
| `GET /leagues?id=39` | `200 OK` | Lists seasons 2010–2026. | 1 call |
| `GET /fixtures?league=39&season=2026` | `200 OK`, `results: 0` | **Blocked on free plan:** `errors.plan = "Free plans do not have access to this season, try from 2022 to 2024."` | 1 call |
| `GET /fixtures?league=39&season=2024&last=3` | `200 OK`, `results: 0` | **Blocked on free plan:** `errors.plan = "Free plans do not have access to the Last parameter."` | 1 call |
| `GET /fixtures?league=39&date=2026-11-23` | `200 OK`, `results: 0` | **Blocked outside 3-day window:** `errors.plan = "Free plans do not have access to this date, try from 2026-11-24 to 2026-11-26."` | 1 call |
| `GET /fixtures?league=39&date=2026-11-28` | `200 OK`, `results: 0` | **Blocked outside 3-day window:** same 3-day window restriction (`today` ± 1 day). | 1 call |
| `GET /fixtures?league=39&live=all` | `200 OK`, `errors: []` | **Works for 2026 live matches.** Tested with `/fixtures?live=all`, returned 2026 live fixtures (`results: 2`, `errors: []`). | 1 call |
| `GET /teams?league=39&season=2024` | `200 OK`, `results: 20` | Works for 2022–2024 seasons. | 1 call |

### Summary for API-Football free plan
- **Usable for:** Live in-play Premier League scores (`/fixtures?league=39&live=all`, cached 60s) and same-day/±1-day fixture status & score checks (`/fixtures?league=39&date=YYYY-MM-DD`).
- **Not usable for:** Fetching upcoming fixtures >1 day ahead, fetching yesterday's/older finished matches (`date` outside 3-day window), or querying `season=2026` / `last=N`.

---

## 2. Fallbacks Checked

### A. Fantasy Premier League Official API (`fantasy.premierleague.com/api/`) — **Selected Primary for 2026/27 Schedule & Scores**
- `GET /api/bootstrap-static/`: `200 OK` (no API key). Returns all 20 current-season Premier League teams (`id`, `name`, `short_name`).
- `GET /api/fixtures/`: `200 OK` (no API key). Returns all **380 fixtures** for the 2026/27 season with `id`, `kickoff_time` (UTC ISO-8601), `team_h`, `team_a`, `started`, `finished`, `finished_provisional`, `minutes`, `team_h_score`, `team_a_score`.
- Verified sample:
  - Upcoming: `#119 2026-11-27T20:00:00Z Nott'm Forest vs Chelsea`
  - Finished: `#103 2026-11-23T20:00:00Z Brentford 4 - 0 Everton`
- **Call cost:** Free, no API-Football quota consumed.
- **Caveat:** Team names differ from `football-data.co.uk` on 5 clubs (`Coventry City` -> `coventry`, `Hull City` -> `hull`, `Ipswich Town` -> `ipswich`, `Man Utd` -> `manchester united`, `Spurs` -> `tottenham`); resolved via `jobs/teams.py` and shared team mapping table.

### B. `football-data.co.uk` CSVs — **Selected Primary for Historical Training & Current-Season Completed CSV**
- `GET /mmz4281/2627/E0.csv`: `200 OK`, 111 lines (110 completed 2026/27 Premier League matches through `23/11/2026`). Reuses Phase 1 `footpred.data.parse_csv` and runtime-only cache (`data/raw/`, never committed).
- `GET /fixtures.csv`: `200 OK`, 44 lines (posts upcoming weekend fixtures closer to matchdays; returned 0 `E0` rows on Tuesday 2026-11-24). Usable as secondary fallback if FPL is temporarily unreachable.

### C. `football-data.org` (`api.football-data.org/v4/competitions/PL/matches`)
- Unauthenticated request returned `403` (`restricted and apparently not within your permissions`). Not used (no API key provided).

### D. Premier League PulseLive API (`footballapi.pulselive.com`)
- Returned `429 Access Denied` HTML block. Not used.

### E. ESPN Public Scoreboard (`site.api.espn.com/.../eng.1/scoreboard`)
- Returned `403 Access Denied`. Not used.

### F. TheSportsDB (`thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=4328`)
- Key `3` disabled (`403`); free test key `123` returned `200 OK` with `events: 1` (truncated free tier). Not suitable as primary; not needed given FPL + API-Football.

---

## 3. Chosen Source Architecture Per Need

| Need | Primary Source | Fallback Source | Caching & Budget Policy |
|---|---|---|---|
| Historical + 2026/27 training results (Python job) | `football-data.co.uk` (`2021`–`2627/E0.csv`, runtime cached) + FPL finished 2026/27 matches not yet in CSV | `football-data.co.uk` CSVs alone | Runtime-cached in Actions (`data/raw/`), never committed |
| Upcoming 7-day fixtures & team sync (Python job -> `/ingest`) | FPL API (`bootstrap-static` + `fixtures`) | `football-data.co.uk/fixtures.csv` | Runs once daily (~05:00 UTC) + manual trigger |
| Live scores (`/live` command in Worker) | API-Football `/fixtures?league=39&live=all` | FPL `/api/fixtures/` (`started && !finished`) | 60s cache in D1; guarded by 80/day API-Football cap |
| Match grading (Worker cron every 15–30 min) | FPL `/api/fixtures/` (0 quota) | API-Football `/fixtures?league=39&date=YYYY-MM-DD` (today only, within 80/day cap) | Runs external fetch **only** when D1 has an ungraded match past kickoff + 105m |
| Recent results (`/results` command in Worker) | D1 `results` + `prediction_results` (populated by grading cron & daily ingest) | FPL `/api/fixtures/` (`finished=true`) | Served from D1 (`0` external calls on read) |
