"""Daily Premier League prediction and ingest job reusing Phase 1 footpred models."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

import numpy as np
import pandas as pd

from footpred.data import parse_csv, season_code
from footpred.models.elo import Elo
from footpred.models.form import RecentForm
from footpred.models.poisson import GoalModel
from jobs.config import DEFAULT_LEAGUE, LEAGUES, LeagueConfig
from jobs.sources import (
    CompositeSource,
    FixtureRecord,
    FootballDataCsvSource,
    FplSource,
    filter_upcoming_window,
)
from jobs.teams import DISPLAY_NAMES, USER_NICKNAMES


def load_frozen_config(path: Path = Path('results/frozen_config.json')) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def config_digest(cfg: dict) -> str:
    canonical = json.dumps(
        {'models': cfg['models'], 'weights': cfg['weights'], 'rules': cfg['rules']},
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]


def ensure_league_csvs(data_dir: Path, league: LeagueConfig) -> list[int]:
    from scripts.fetch_snapshots import fetch

    seasons = list(league.historical_seasons) + [league.current_season]
    available: list[int] = []
    for s in seasons:
        sc = season_code(s)
        try:
            fetch(data_dir, sc, league.code)
            available.append(s)
        except Exception as exc:
            if s == league.current_season:
                print(f'Warning: current season CSV {sc}/{league.code} unavailable: {exc}', file=sys.stderr)
            else:
                raise
    return available


def build_training_history(
    data_dir: Path,
    league: LeagueConfig,
    seasons: list[int],
    live_fixtures: list[FixtureRecord],
    now_utc: datetime,
) -> pd.DataFrame:
    frames = []
    for s in seasons:
        csv_path = data_dir / season_code(s) / f'{league.code}.csv'
        if csv_path.is_file():
            df, _ = parse_csv(csv_path, league.code, s)
            frames.append(df[['date', 'league', 'season', 'home', 'away', 'hg', 'ag']])

    history = (
        pd.concat(frames, ignore_index=True)
        if frames
        else pd.DataFrame(columns=['date', 'league', 'season', 'home', 'away', 'hg', 'ag'])
    )

    existing_keys = {
        (int(r.season), str(r.home), str(r.away))
        for r in history[['season', 'home', 'away']].itertuples(index=False)
    }

    extra_rows = []
    for fx in live_fixtures:
        if fx.status != 'FT' or fx.home_goals is None or fx.away_goals is None:
            continue
        ko = datetime.fromisoformat(fx.kickoff_utc.replace('Z', '+00:00'))
        if ko >= now_utc:
            continue
        key = (fx.season, fx.home, fx.away)
        if key in existing_keys:
            continue
        existing_keys.add(key)
        extra_rows.append(
            {
                'date': pd.Timestamp(ko.date()),
                'league': fx.league,
                'season': fx.season,
                'home': fx.home,
                'away': fx.away,
                'hg': int(fx.home_goals),
                'ag': int(fx.away_goals),
            }
        )

    if extra_rows:
        history = pd.concat([history, pd.DataFrame(extra_rows)], ignore_index=True)

    return history.sort_values(['date', 'home', 'away']).reset_index(drop=True)


def fit_frozen_models(history: pd.DataFrame, cfg: dict, cutoff: pd.Timestamp) -> dict[str, object]:
    models_cfg = cfg['models']
    return {
        'dixon_coles': GoalModel(**models_cfg['dixon_coles']).fit(history, cutoff),
        'poisson': GoalModel(**models_cfg['poisson']).fit(history, cutoff),
        'elo': Elo(**models_cfg['elo']).fit(history, cutoff),
        'form': RecentForm(**models_cfg['form']).fit(history, cutoff),
    }


def ensemble_predict(models: dict[str, object], weights: dict[str, dict[str, float]], home: str, away: str) -> dict:
    per_model = {name: m.predict(home, away) for name, m in models.items()}
    out = {}
    for market, w_map in weights.items():
        vec = np.zeros_like(next(iter(per_model.values()))[market], dtype=float)
        for name, weight in w_map.items():
            vec += float(weight) * np.asarray(per_model[name][market], dtype=float)
        vec = np.clip(vec, 0.0, 1.0)
        total = float(vec.sum())
        if total <= 0:
            raise ValueError(f'Non-positive probability sum for {home} vs {away} ({market})')
        out[market] = vec / total

    dc: GoalModel = models['dixon_coles']  # type: ignore[assignment]
    xg_home, xg_away = dc.rates(home, away)
    elo: Elo = models['elo']  # type: ignore[assignment]
    r_home = float(elo.ratings_.get(home, 0.0))
    r_away = float(elo.ratings_.get(away, 0.0))

    p_h, p_d, p_a = [float(x) for x in out['1X2']]
    idx = int(np.argmax([p_h, p_d, p_a]))
    outcome = ('H', 'D', 'A')[idx]
    top_two = sorted([p_h, p_d, p_a], reverse=True)
    gap = top_two[0] - top_two[1]

    if gap < 0.08:
        reason = 'Tight matchup on ratings and recent goal rates; draw risk is elevated.'
    elif outcome == 'H':
        reason = (
            f'Home edge ({xg_home:.2f} vs {xg_away:.2f} xG; Elo {r_home - r_away:+.0f} before home boost).'
        )
    elif outcome == 'A':
        reason = (
            f'Stronger away profile ({xg_away:.2f} vs {xg_home:.2f} xG; Elo {r_away - r_home:+.0f}).'
        )
    else:
        reason = f'Balanced expected scoring ({xg_home:.2f} vs {xg_away:.2f} xG) favours a draw.'

    return {
        'p_home': round(p_h, 6),
        'p_draw': round(p_d, 6),
        'p_away': round(p_a, 6),
        'p_over25': round(float(out['OU25'][0]), 6),
        'p_btts': round(float(out['BTTS'][0]), 6),
        'xg_home': round(float(xg_home), 3),
        'xg_away': round(float(xg_away), 3),
        'predicted_outcome': outcome,
        'summary_reason': reason,
    }


def extract_team_strengths(models: dict[str, object], teams: list[str]) -> dict:
    dc: GoalModel = models['dixon_coles']  # type: ignore[assignment]
    elo: Elo = models['elo']  # type: ignore[assignment]
    return {
        'base': float(dc.base_),
        'home_adv': float(dc.home_),
        'rho': float(dc.rho),
        'teams': {
            t: {
                'attack': round(float(dc.attack_.get(t, 0.0)), 5),
                'defence': round(float(dc.defence_.get(t, 0.0)), 5),
                'elo': round(float(elo.ratings_.get(t, 0.0)), 2),
            }
            for t in teams
        },
    }


def build_ingest_payload(
    league: LeagueConfig,
    cfg: dict,
    models: dict[str, object],
    fixtures: list[FixtureRecord],
    now_utc: datetime,
    window_hours: float = 36.0,
    fixture_horizon_days: int = 14,
) -> dict:
    model_version = cfg['model_version']
    c_hash = config_digest(cfg)

    horizon_end = now_utc + timedelta(days=fixture_horizon_days)
    recent_start = now_utc - timedelta(days=14)

    selected_fixtures: list[FixtureRecord] = []
    for fx in fixtures:
        ko = datetime.fromisoformat(fx.kickoff_utc.replace('Z', '+00:00'))
        if recent_start <= ko <= horizon_end:
            selected_fixtures.append(fx)

    upcoming_pred_fixtures = filter_upcoming_window(fixtures, now_utc, window_hours)

    # Ensure every fixture referenced by a prediction is included
    fx_by_id = {f.match_id: f for f in selected_fixtures}
    for f in upcoming_pred_fixtures:
        fx_by_id.setdefault(f.match_id, f)

    teams_payload = [
        {
            'canonical_name': canon,
            'display_name': DISPLAY_NAMES.get(canon, canon.title()),
            'short_name': None,
            'aliases': aliases,
        }
        for canon, aliases in sorted(USER_NICKNAMES.items())
    ]

    fixtures_payload = [
        {
            'match_id': f.match_id,
            'league': f.league,
            'season': f.season,
            'home_team': f.home,
            'away_team': f.away,
            'home_display': f.home_display,
            'away_display': f.away_display,
            'kickoff_utc': f.kickoff_utc,
            'status': f.status,
            'provider': f.provider,
            'provider_id': f.provider_id,
        }
        for f in sorted(fx_by_id.values(), key=lambda x: x.kickoff_utc)
    ]

    results_payload = [
        {
            'match_id': f.match_id,
            'home_goals': int(f.home_goals),
            'away_goals': int(f.away_goals),
            'actual_outcome': ('H' if f.home_goals > f.away_goals else 'A' if f.away_goals > f.home_goals else 'D'),
            'status': 'FT',
            'source': f.provider or 'fpl',
        }
        for f in selected_fixtures
        if f.status == 'FT' and f.home_goals is not None and f.away_goals is not None
    ]

    predictions_payload = []
    for f in upcoming_pred_fixtures:
        pred = ensemble_predict(models, cfg['weights'], f.home, f.away)
        # Re-normalize rounded 1X2 probabilities to sum strictly to 1.0
        p_sum = pred['p_home'] + pred['p_draw'] + pred['p_away']
        if abs(p_sum - 1.0) > 1e-6:
            pred['p_away'] = round(1.0 - pred['p_home'] - pred['p_draw'], 6)
        predictions_payload.append(
            {
                'match_id': f.match_id,
                'model_version': model_version,
                'config_hash': c_hash,
                'kickoff_utc': f.kickoff_utc,
                **pred,
            }
        )

    team_keys = sorted({f.home for f in fixtures} | {f.away for f in fixtures} | set(USER_NICKNAMES))
    return {
        'model_version': {
            'model_version': model_version,
            'config_hash': c_hash,
            'description': 'Phase 1 frozen ensemble (Dixon-Coles + Elo + Poisson + Form)',
        },
        'teams': teams_payload,
        'fixtures': fixtures_payload,
        'results': results_payload,
        'predictions': predictions_payload,
        'team_strengths': {
            'league': league.code,
            'generated_at': now_utc.strftime('%Y-%m-%dT%H:%M:%SZ'),
            **extract_team_strengths(models, team_keys),
        },
    }


def post_ingest(worker_url: str, ingest_secret: str, payload: dict) -> dict:
    url = worker_url.rstrip('/') + '/ingest'
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        method='POST',
        headers={
            'Authorization': f'Bearer {ingest_secret}',
            'Content-Type': 'application/json',
            'User-Agent': 'FootballPredictorJob/2.0',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'Ingest HTTP {exc.code}: {detail}') from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--league', default=DEFAULT_LEAGUE, choices=sorted(LEAGUES))
    parser.add_argument('--data-dir', type=Path, default=Path('data/raw'))
    parser.add_argument('--frozen-config', type=Path, default=Path('results/frozen_config.json'))
    parser.add_argument('--window-hours', type=float, default=36.0)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    league = LEAGUES[args.league]
    cfg = load_frozen_config(args.frozen_config)
    now_utc = datetime.now(timezone.utc)

    seasons = ensure_league_csvs(args.data_dir, league)
    source = CompositeSource([FplSource(), FootballDataCsvSource()])
    fetch_res = source.fetch_season_fixtures(league)
    if fetch_res.unmapped_teams:
        print(f'Unmapped team names from {fetch_res.source_used}: {sorted(fetch_res.unmapped_teams)}', file=sys.stderr)

    history = build_training_history(args.data_dir, league, seasons, fetch_res.fixtures, now_utc)
    cutoff = pd.Timestamp(now_utc.date()) + pd.Timedelta(days=1)
    models = fit_frozen_models(history, cfg, cutoff)

    payload = build_ingest_payload(
        league=league,
        cfg=cfg,
        models=models,
        fixtures=fetch_res.fixtures,
        now_utc=now_utc,
        window_hours=args.window_hours,
    )

    print(
        f'Prepared ingest ({fetch_res.source_used}): '
        f'{len(history)} training matches, '
        f'{len(payload["fixtures"])} fixtures, '
        f'{len(payload["results"])} results, '
        f'{len(payload["predictions"])} predictions (window={args.window_hours}h)'
    )

    if args.dry_run:
        return 0

    worker_url = os.environ.get('WORKER_URL', '').strip()
    ingest_secret = os.environ.get('INGEST_SECRET', '').strip()
    if not worker_url or not ingest_secret:
        raise RuntimeError('WORKER_URL and INGEST_SECRET must be set unless --dry-run is used')

    resp = post_ingest(worker_url, ingest_secret, payload)
    print('Ingest response:', json.dumps(resp))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
