from datetime import datetime, timedelta, timezone
from pathlib import Path
import pandas as pd

from jobs.config import LEAGUES
from jobs.predict_and_ingest import (
    build_ingest_payload,
    config_digest,
    fit_frozen_models,
    load_frozen_config,
)
from jobs.sources import FixtureRecord


def _synthetic_history(start_date: str = '2026-08-15', rounds: int = 8) -> pd.DataFrame:
    teams = ['arsenal', 'chelsea', 'liverpool', 'manchester city', 'tottenham', 'everton']
    rows = []
    base = pd.Timestamp(start_date)
    day = 0
    for r in range(rounds):
        for i in range(0, len(teams), 2):
            h, a = (teams[i], teams[i + 1]) if r % 2 == 0 else (teams[i + 1], teams[i])
            rows.append({
                'date': base + pd.Timedelta(days=day),
                'league': 'E0',
                'season': 2026,
                'home': h,
                'away': a,
                'hg': 2 if i == 0 else 1,
                'ag': 1 if i == 0 else 1,
            })
            day += 1
    return pd.DataFrame(rows)


def test_build_ingest_payload_respects_window_and_probabilities_sum_to_one():
    cfg = load_frozen_config(Path('results/frozen_config.json'))
    history = _synthetic_history()
    now = datetime(2026, 11, 25, 5, 0, tzinfo=timezone.utc)
    cutoff = pd.Timestamp(now.date()) + pd.Timedelta(days=1)
    models = fit_frozen_models(history, cfg, cutoff)

    fixtures = [
        # Inside 36h window -> must get prediction
        FixtureRecord(
            match_id='E0:2026:arsenal:chelsea',
            league='E0',
            season=2026,
            home='arsenal',
            away='chelsea',
            home_display='Arsenal',
            away_display='Chelsea',
            kickoff_utc=(now + timedelta(hours=20)).strftime('%Y-%m-%dT%H:%M:%SZ'),
            status='NS',
            provider='fpl',
            provider_id='101',
        ),
        # Outside 36h window -> fixture stored, NO locked prediction yet
        FixtureRecord(
            match_id='E0:2026:liverpool:manchester-city',
            league='E0',
            season=2026,
            home='liverpool',
            away='manchester city',
            home_display='Liverpool',
            away_display='Man City',
            kickoff_utc=(now + timedelta(hours=60)).strftime('%Y-%m-%dT%H:%M:%SZ'),
            status='NS',
            provider='fpl',
            provider_id='102',
        ),
        # Already finished -> goes to results, NO prediction
        FixtureRecord(
            match_id='E0:2026:tottenham:everton',
            league='E0',
            season=2026,
            home='tottenham',
            away='everton',
            home_display='Tottenham',
            away_display='Everton',
            kickoff_utc=(now - timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ'),
            status='FT',
            home_goals=2,
            away_goals=0,
            minute=90,
            provider='fpl',
            provider_id='100',
        ),
    ]

    payload = build_ingest_payload(LEAGUES['E0'], cfg, models, fixtures, now, window_hours=36.0)
    assert len(payload['fixtures']) == 3
    assert len(payload['results']) == 1
    assert len(payload['predictions']) == 1

    pred = payload['predictions'][0]
    assert pred['match_id'] == 'E0:2026:arsenal:chelsea'
    assert pred['model_version'] == cfg['model_version']
    assert pred['config_hash'] == config_digest(cfg)
    total = pred['p_home'] + pred['p_draw'] + pred['p_away']
    assert abs(total - 1.0) < 1e-5
    assert 0.0 <= pred['p_home'] <= 1.0
    assert 0.0 <= pred['p_draw'] <= 1.0
    assert 0.0 <= pred['p_away'] <= 1.0
    assert payload['team_strengths']['league'] == 'E0'
    assert 'arsenal' in payload['team_strengths']['teams']
