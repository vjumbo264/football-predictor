"""Fetch Football-Data CSVs at run time; no match data are printed."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from io import BytesIO
from pathlib import Path
import sys
from urllib.request import urlopen
from zipfile import ZipFile

SEASONS = {'train': ('2021', '2122', '2223', '2324'), 'test': ('2425', '2526'), 'forward': ('2627',)}
LEAGUES = ('E0', 'SP1', 'I1', 'D1', 'F1')
HOSTS = ('https://www.football-data.co.uk', 'https://football-data.co.uk')
COLUMNS = {'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG'}


def read(url):
    with urlopen(url, timeout=15) as response:
        return response.read()


def validate(payload):
    line = payload.splitlines()[0].decode('utf-8-sig') if payload.splitlines() else ''
    if not COLUMNS.issubset(next(csv.reader([line]), [])):
        raise ValueError('response did not contain the expected CSV header')
    return payload


def fetch(root, season, league, get=read):
    path = root / season / f'{league}.csv'
    if path.is_file():
        validate(path.read_bytes())
        return
    errors = []
    for filename in (path.name, 'data.zip'):
        for host in HOSTS:
            url = f'{host}/mmz4281/{season}/{filename}'
            try:
                payload = get(url)
                if filename == 'data.zip':
                    with ZipFile(BytesIO(payload)) as archive:
                        member = next(n for n in archive.namelist() if Path(n).name.lower() == path.name.lower())
                        payload = archive.read(member)
                validate(payload)
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix('.part')
                tmp.write_bytes(payload)
                tmp.replace(path)
                if url != f'{HOSTS[0]}/mmz4281/{season}/{path.name}':
                    print(f'{season}/{league}: fallback {url}; previous failures: {"; ".join(errors)}')
                return
            except Exception as exc:
                errors.append(f'{url}: {type(exc).__name__} {exc}')
    raise RuntimeError(f'{season}/{league} unavailable: {"; ".join(errors)}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scope', choices=SEASONS)
    parser.add_argument('--root', type=Path, default=Path('data/raw'))
    args = parser.parse_args()
    errors = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        jobs = [pool.submit(fetch, args.root, s, l) for s in SEASONS[args.scope] for l in LEAGUES]
        for job in jobs:
            try:
                job.result()
            except RuntimeError as exc:
                errors.append(str(exc))
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'{args.scope}: {len(jobs)} required source files present')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
