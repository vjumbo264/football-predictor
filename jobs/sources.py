"""Swappable football data source interface and provider implementations."""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import io
import json
from typing import Callable, Protocol
import urllib.error
import urllib.request

from jobs.config import LeagueConfig
from jobs.teams import canonical_team, display_team

HttpGet = Callable[[str, dict[str, str] | None], tuple[int, bytes]]


def default_http_get(url: str, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    req_headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; FootballPredictor/2.0)',
        'Accept': 'application/json, text/csv, */*',
    }
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def make_match_id(league: str, season: int, home: str, away: str) -> str:
    h = home.replace(' ', '-')
    a = away.replace(' ', '-')
    return f'{league}:{season}:{h}:{a}'


@dataclass(frozen=True)
class FixtureRecord:
    match_id: str
    league: str
    season: int
    home: str
    away: str
    home_display: str
    away_display: str
    kickoff_utc: str            # ISO-8601 UTC with Z suffix
    status: str                 # NS | LIVE | FT | PST
    home_goals: int | None = None
    away_goals: int | None = None
    minute: int | None = None
    provider: str = ''
    provider_id: str | None = None


@dataclass
class FetchResult:
    fixtures: list[FixtureRecord]
    source_used: str
    unmapped_teams: set[str] = field(default_factory=set)
    errors: list[str] = field(default_factory=list)


class FixtureSource(Protocol):
    name: str

    def fetch_season_fixtures(self, league: LeagueConfig) -> FetchResult: ...


class FplSource:
    """Official Fantasy Premier League API (bootstrap-static + fixtures)."""

    name = 'fpl'
    BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/'
    FIXTURES_URL = 'https://fantasy.premierleague.com/api/fixtures/'

    def __init__(self, http_get: HttpGet = default_http_get):
        self.http_get = http_get

    def fetch_season_fixtures(self, league: LeagueConfig) -> FetchResult:
        if not league.fpl_enabled:
            raise ValueError(f'FPL source is not enabled for league {league.code}')
        st_b, raw_b = self.http_get(self.BOOTSTRAP_URL, None)
        if st_b != 200:
            raise RuntimeError(f'FPL bootstrap HTTP {st_b}')
        st_f, raw_f = self.http_get(self.FIXTURES_URL, None)
        if st_f != 200:
            raise RuntimeError(f'FPL fixtures HTTP {st_f}')

        bootstrap = json.loads(raw_b.decode('utf-8'))
        fixtures_json = json.loads(raw_f.decode('utf-8'))

        unmapped: set[str] = set()
        team_map: dict[int, tuple[str, str]] = {}
        for t in bootstrap.get('teams', []):
            canon = canonical_team(t['name'], unmapped)
            team_map[int(t['id'])] = (canon, display_team(canon))

        records: list[FixtureRecord] = []
        for fx in fixtures_json:
            kickoff = fx.get('kickoff_time')
            if not kickoff:
                continue
            h_id = int(fx['team_h'])
            a_id = int(fx['team_a'])
            if h_id not in team_map or a_id not in team_map:
                continue
            home, home_disp = team_map[h_id]
            away, away_disp = team_map[a_id]
            finished = bool(fx.get('finished') or fx.get('finished_provisional'))
            started = bool(fx.get('started'))
            if finished:
                status = 'FT'
            elif started:
                status = 'LIVE'
            else:
                status = 'NS'
            # Normalize kickoff to Z format
            dt = datetime.fromisoformat(kickoff.replace('Z', '+00:00')).astimezone(timezone.utc)
            records.append(
                FixtureRecord(
                    match_id=make_match_id(league.code, league.current_season, home, away),
                    league=league.code,
                    season=league.current_season,
                    home=home,
                    away=away,
                    home_display=home_disp,
                    away_display=away_disp,
                    kickoff_utc=dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
                    status=status,
                    home_goals=fx.get('team_h_score') if (started or finished) else None,
                    away_goals=fx.get('team_a_score') if (started or finished) else None,
                    minute=fx.get('minutes') if status == 'LIVE' else (90 if status == 'FT' else None),
                    provider=self.name,
                    provider_id=str(fx['id']),
                )
            )
        return FetchResult(fixtures=records, source_used=self.name, unmapped_teams=unmapped)


class FootballDataCsvSource:
    """football-data.co.uk season CSV (results) + fixtures.csv (upcoming fallback)."""

    name = 'football_data_csv'
    HOSTS = ('https://www.football-data.co.uk', 'https://football-data.co.uk')

    def __init__(self, http_get: HttpGet = default_http_get):
        self.http_get = http_get

    @staticmethod
    def _season_code(season: int) -> str:
        return f'{season % 100:02d}{(season + 1) % 100:02d}'

    def _fetch_csv_rows(self, path: str) -> list[dict[str, str]]:
        last_err = ''
        for host in self.HOSTS:
            st, raw = self.http_get(f'{host}/{path}', None)
            if st == 200:
                text = raw.decode('utf-8-sig', errors='replace')
                return list(csv.DictReader(io.StringIO(text)))
            last_err = f'{host}/{path} HTTP {st}'
        raise RuntimeError(last_err)

    @staticmethod
    def _parse_dt(date_str: str, time_str: str) -> str:
        t = (time_str or '15:00').strip()
        for fmt in ('%d/%m/%Y %H:%M', '%d/%m/%y %H:%M'):
            try:
                dt = datetime.strptime(f'{date_str.strip()} {t}', fmt).replace(tzinfo=timezone.utc)
                return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
            except ValueError:
                continue
        raise ValueError(f'Unrecognized date/time: {date_str!r} {time_str!r}')

    def fetch_season_fixtures(self, league: LeagueConfig) -> FetchResult:
        unmapped: set[str] = set()
        seen: dict[str, FixtureRecord] = {}
        sc = self._season_code(league.current_season)
        for r in self._fetch_csv_rows(f'mmz4281/{sc}/{league.code}.csv'):
            if r.get('Div', '').strip() not in ('', league.code):
                continue
            if not r.get('HomeTeam') or not r.get('AwayTeam') or not r.get('Date'):
                continue
            home = canonical_team(r['HomeTeam'], unmapped)
            away = canonical_team(r['AwayTeam'], unmapped)
            mid = make_match_id(league.code, league.current_season, home, away)
            hg = int(r['FTHG']) if r.get('FTHG', '').strip().isdigit() else None
            ag = int(r['FTAG']) if r.get('FTAG', '').strip().isdigit() else None
            seen[mid] = FixtureRecord(
                match_id=mid,
                league=league.code,
                season=league.current_season,
                home=home,
                away=away,
                home_display=display_team(home),
                away_display=display_team(away),
                kickoff_utc=self._parse_dt(r['Date'], r.get('Time', '15:00')),
                status='FT' if (hg is not None and ag is not None) else 'NS',
                home_goals=hg,
                away_goals=ag,
                minute=90 if (hg is not None and ag is not None) else None,
                provider=self.name,
                provider_id=None,
            )

        try:
            for r in self._fetch_csv_rows('fixtures.csv'):
                if r.get('Div', '').strip() != league.code:
                    continue
                if not r.get('HomeTeam') or not r.get('AwayTeam') or not r.get('Date'):
                    continue
                home = canonical_team(r['HomeTeam'], unmapped)
                away = canonical_team(r['AwayTeam'], unmapped)
                mid = make_match_id(league.code, league.current_season, home, away)
                if mid in seen:
                    continue
                seen[mid] = FixtureRecord(
                    match_id=mid,
                    league=league.code,
                    season=league.current_season,
                    home=home,
                    away=away,
                    home_display=display_team(home),
                    away_display=display_team(away),
                    kickoff_utc=self._parse_dt(r['Date'], r.get('Time', '15:00')),
                    status='NS',
                    provider=self.name,
                )
        except Exception:
            pass

        return FetchResult(fixtures=list(seen.values()), source_used=self.name, unmapped_teams=unmapped)


class ApiFootballSource:
    """API-Football v3 adapter (free plan supports live=all and today +/-1 day only)."""

    name = 'api_football'
    BASE_URL = 'https://v3.football.api-sports.io'
    LIVE_CODES = {'1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE'}
    FT_CODES = {'FT', 'AET', 'PEN'}
    PST_CODES = {'PST', 'CANC', 'ABD', 'SUSP', 'AWD', 'WO'}

    def __init__(self, api_key: str, http_get: HttpGet = default_http_get):
        self.api_key = api_key
        self.http_get = http_get

    def _call(self, path: str) -> dict:
        st, raw = self.http_get(f'{self.BASE_URL}{path}', {'x-apisports-key': self.api_key})
        if st != 200:
            raise RuntimeError(f'API-Football HTTP {st}')
        payload = json.loads(raw.decode('utf-8'))
        errors = payload.get('errors')
        if errors:
            raise RuntimeError(f'API-Football plan/api error: {errors}')
        return payload

    def _parse_response(self, league: LeagueConfig, payload: dict) -> FetchResult:
        unmapped: set[str] = set()
        records: list[FixtureRecord] = []
        for item in payload.get('response', []):
            fx = item['fixture']
            teams = item['teams']
            goals = item['goals']
            home = canonical_team(teams['home']['name'], unmapped)
            away = canonical_team(teams['away']['name'], unmapped)
            short = fx['status'].get('short', 'NS')
            if short in self.FT_CODES:
                status = 'FT'
            elif short in self.LIVE_CODES:
                status = 'LIVE'
            elif short in self.PST_CODES:
                status = 'PST'
            else:
                status = 'NS'
            dt = datetime.fromisoformat(fx['date'].replace('Z', '+00:00')).astimezone(timezone.utc)
            records.append(
                FixtureRecord(
                    match_id=make_match_id(league.code, league.current_season, home, away),
                    league=league.code,
                    season=league.current_season,
                    home=home,
                    away=away,
                    home_display=display_team(home),
                    away_display=display_team(away),
                    kickoff_utc=dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
                    status=status,
                    home_goals=goals.get('home'),
                    away_goals=goals.get('away'),
                    minute=fx['status'].get('elapsed'),
                    provider=self.name,
                    provider_id=str(fx['id']),
                )
            )
        return FetchResult(fixtures=records, source_used=self.name, unmapped_teams=unmapped)

    def fetch_live(self, league: LeagueConfig) -> FetchResult:
        payload = self._call(f'/fixtures?league={league.api_football_id}&live=all')
        return self._parse_response(league, payload)

    def fetch_by_date(self, league: LeagueConfig, date_yyyy_mm_dd: str) -> FetchResult:
        payload = self._call(f'/fixtures?league={league.api_football_id}&date={date_yyyy_mm_dd}')
        return self._parse_response(league, payload)

    def fetch_season_fixtures(self, league: LeagueConfig) -> FetchResult:
        # Attempt current-season query first; free plan rejects this, so fallback to today.
        try:
            payload = self._call(f'/fixtures?league={league.api_football_id}&season={league.current_season}')
            return self._parse_response(league, payload)
        except RuntimeError:
            today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            return self.fetch_by_date(league, today)


class CompositeSource:
    """Queries sources in priority order with explicit fallback and unmapped reporting."""

    def __init__(self, sources: list[FixtureSource]):
        self.sources = sources

    def fetch_season_fixtures(self, league: LeagueConfig) -> FetchResult:
        errors: list[str] = []
        for src in self.sources:
            try:
                res = src.fetch_season_fixtures(league)
                res.errors.extend(errors)
                return res
            except Exception as exc:
                errors.append(f'{src.name}: {exc}')
        raise RuntimeError('All fixture sources failed: ' + '; '.join(errors))


def filter_upcoming_window(fixtures: list[FixtureRecord], now_utc: datetime, hours: float) -> list[FixtureRecord]:
    end = now_utc + timedelta(hours=hours)
    out = []
    for f in fixtures:
        if f.status != 'NS':
            continue
        ko = datetime.fromisoformat(f.kickoff_utc.replace('Z', '+00:00'))
        if now_utc < ko <= end:
            out.append(f)
    return sorted(out, key=lambda x: x.kickoff_utc)
