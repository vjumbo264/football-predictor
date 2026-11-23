from io import BytesIO
from zipfile import ZipFile

import pytest
from scripts import fetch_snapshots as source

CSV = b'Date,HomeTeam,AwayTeam,FTHG,FTAG\n02/08/23,Example A,Example B,1,0\n'


def test_same_publisher_zip_fallback_and_reuse(tmp_path):
    calls = []
    buf = BytesIO()
    with ZipFile(buf, 'w') as archive:
        archive.writestr('E0.csv', CSV)

    def fetch(url):
        calls.append(url)
        if url.endswith('data.zip'):
            return buf.getvalue()
        return b'<html>not a CSV</html>'

    source.fetch(tmp_path, '2324', 'E0', fetch)
    assert len(calls) == 3 and calls[-1].endswith('2324/data.zip')
    assert (tmp_path/'2324'/'E0.csv').read_bytes() == CSV
    source.fetch(tmp_path, '2324', 'E0', fetch)
    assert len(calls) == 3


def test_failed_league_names_failed_endpoints_and_writes_nothing(tmp_path):
    def fail(url):
        raise TimeoutError('synthetic failure')

    with pytest.raises(RuntimeError, match=r'2324/F1 unavailable:.*F1.csv.*data.zip'):
        source.fetch(tmp_path, '2324', 'F1', fail)
    assert not list(tmp_path.rglob('*.csv'))
