"""Parse explicitly authorized Football-Data-format snapshots; never fetch implicitly."""
import csv
import hashlib
import io
import re
import unicodedata
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

LEAGUES = ('E0', 'SP1', 'I1', 'D1', 'F1')
COMPLETED = (2020, 2021, 2022, 2023, 2024, 2025)
FORWARD = 2026
ALIASES = {'man united': 'manchester united', 'man city': 'manchester city',
           'paris sg': 'paris saint germain', 'internazionale': 'inter',
           'ath madrid': 'atletico madrid', 'bayern munich': 'bayern munchen',
           'spvgg greuther furth': 'greuther furth', 'm gladbach': 'monchengladbach'}
BOOK_1X2 = ('PS', 'P', 'Avg', 'BbAv', 'B365', 'BW', 'IW', 'WH', 'BF', '1XB', 'VC', 'LB', 'Max')
BOOK_OU = ('P', 'Avg', 'BbAv', 'B365', 'GB', 'BF', '1XB', 'Max')
ODDS_FIELDS = tuple(sorted({book + c + o for books, outcomes in
                            [(BOOK_1X2, 'HDA'), (BOOK_OU, ('>2.5', '<2.5'))]
                            for book in books for c in ('', 'C') for o in outcomes}))
MARKETS = {'1X2': ('H', 'D', 'A'), 'OU25': ('Over', 'Under'), 'BTTS': ('Yes', 'No')}


def season_code(season):
    return f'{season % 100:02d}{(season+1) % 100:02d}'


def team_name(s):
    s = unicodedata.normalize('NFKD', s.casefold()).encode('ascii', 'ignore').decode()
    key = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return ALIASES.get(key, key)


def _date(s):
    for fmt in ('%d/%m/%Y', '%d/%m/%y'):
        try:
            return pd.Timestamp(datetime.strptime(s, fmt))
        except ValueError:
            continue
    raise ValueError(f'invalid match date: {s!r}')


def _odds(s):
    try:
        n = float(s)
        return n if np.isfinite(n) and n > 1 else np.nan
    except (TypeError, ValueError):
        return np.nan


def parse_csv(path, league, season):
    raw = Path(path).read_bytes()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp1252', errors='replace')
    reader = csv.DictReader(io.StringIO(text.replace('\x00', '')))
    reader.fieldnames = [x.strip() for x in reader.fieldnames or []]
    core = ['Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG']
    if not set(core).issubset(reader.fieldnames):
        raise ValueError(f'{path}: missing required columns {set(core) - set(reader.fieldnames)}')
    rows, rejected, forms = [], [], {}
    for line, record in enumerate(reader, 2):
        r = {k: str(v or '').strip() for k, v in record.items() if k}
        if not any(r.values()):
            continue
        try:
            d = _date(r['Date'])
            hg, ag = int(r['FTHG']), int(r['FTAG'])
            h, a = team_name(r['HomeTeam']), team_name(r['AwayTeam'])
            expected = 'H' if hg > ag else 'A' if ag > hg else 'D'
            if (not h or not a or h == a or not 0 <= min(hg, ag) <= max(hg, ag) <= 30
                    or r.get('FTR', '') not in ('', expected) or r.get('Div', '') not in ('', league)
                    or not pd.Timestamp(season, 7, 1) <= d < pd.Timestamp(season+1, 7, 1)):
                raise ValueError('inconsistent match, league, season, or score')
        except ValueError as error:
            rejected.append((line, str(error)))
            continue
        for key, label in ((h, r['HomeTeam']), (a, r['AwayTeam'])):
            forms.setdefault(key, set()).add(label)
        rows.append(dict(date=d, league=league, season=season, home=h, away=a, hg=hg, ag=ag,
                         **{field: _odds(r.get(field)) for field in ODDS_FIELDS}))
    f = pd.DataFrame(rows, columns=['date', 'league', 'season', 'home', 'away', 'hg', 'ag', *ODDS_FIELDS])
    # Each ordered pair is unique within a double round-robin league season.
    # Refuse conflicting duplicates instead of guessing which price/result to use.
    duplicate = f.duplicated(['home', 'away'], keep=False)
    for _, group in f[duplicate].groupby(['home', 'away']):
        if len(group.drop_duplicates()) != 1:
            raise ValueError(f'{path}: conflicting records for {group.iloc[0].home} vs {group.iloc[0].away}')
    count = len(f)
    f = f.drop_duplicates(['home', 'away']).sort_values(['date', 'home', 'away']).reset_index(drop=True)
    teams = set(f.home) | set(f.away)
    expected_teams = 18 if league == 'D1' or (league == 'F1' and season >= 2023) else 20
    weeks = f.date.sort_values().drop_duplicates().diff().dt.days if len(f) else pd.Series(dtype=float)
    suspicious = sorted(t for t in teams if not re.fullmatch('[a-z][a-z0-9 ]{1,}', t))
    quality = {'league': league, 'season': season, 'matches': len(f), 'teams': len(teams),
               'expected_full_season': expected_teams * (expected_teams-1), 'rejected': rejected,
               'duplicates_removed': count-len(f), 'gaps_over_14_days': [(str(f.date.loc[i].date()), int(gap)) for i, gap in weeks.dropna().items() if gap > 14],
               'missing_odds': {c: float(f[c].isna().mean()) if len(f) else None for c in ODDS_FIELDS},
               'name_map': {k: sorted(v) for k, v in forms.items()}, 'suspicious_names': suspicious,
               'sha256': hashlib.sha256(raw).hexdigest()}
    return f, quality


def load_snapshot(root, seasons=COMPLETED, leagues=LEAGUES):
    """Require every requested league-season file; scopes are supplied by the caller."""
    frames, audit = [], []
    for league in leagues:
        for season in seasons:
            frame, quality = parse_csv(Path(root) / season_code(season) / f'{league}.csv', league, season)
            frames.append(frame)
            audit.append(quality)
    out = pd.concat(frames, ignore_index=True).sort_values(['date', 'league', 'home', 'away']).reset_index(drop=True)
    return out, audit


def outcomes(h, a):
    return (0 if h>a else 1 if h==a else 2, int(h+a<3), int(not (h>0 and a>0)))


def quality_markdown(audits):
    lines = ['# Data quality', '', '| League | Season start | Matches | Full-season expected | Teams | Removed duplicates | Rejected rows |', '|---|---:|---:|---:|---:|---:|---:|']
    for a in audits:
        lines.append('| ' + ' | '.join(str(a[k]) for k in ('league','season','matches','expected_full_season','teams','duplicates_removed')) + f' | {len(a["rejected"])} |')
    for a in audits:
        lines.extend(['', f'## {a["league"]} {a["season"]}', '', f'- SHA-256: `{a["sha256"]}`',
                      f'- Date gaps over 14 days: {a["gaps_over_14_days"] or "none"}',
                      f'- Rejected lines: {a["rejected"] or "none"}',
                      f'- Suspicious names: {a["suspicious_names"] or "none by format check"}',
                      '- Source spellings requiring manual review if unexpected: ' + repr(a['name_map']),
                      '- Missing odds by column: ' + ', '.join(f'{k}: {v:.1%}' for k,v in a['missing_odds'].items() if v is not None)])
    return '\n'.join(lines) + '\n'
