import pytest
from footpred.data import parse_csv, quality_markdown, team_name


def test_parse_dates_missing_and_bad_odds(tmp_path):
    p = tmp_path / 'input.csv'
    p.write_text('Date,HomeTeam,AwayTeam,FTHG,FTAG,PSH,\n'
                 '08/09/24,Man United,Arsenal,2,0,1.90,\n'
                 '09/09/2024,Arsenal,Man United,1,1,broken,\n'
                 '09/09/2024,Arsenal,Man United,1,1,broken,\n'
                 '31/02/24,A,B,1,0,1,\n,,,,,,\n')
    f, audit = parse_csv(p, 'E0', 2024)
    assert f.date.dt.strftime('%F').tolist() == ['2024-09-08', '2024-09-09']
    assert f.home.tolist() == ['manchester united', 'arsenal']
    assert f.PSH.iloc[0] == 1.90 and f.PSH.isna().sum() == 1
    assert f['Avg>2.5'].isna().all()
    assert audit['duplicates_removed'] == 1 and len(audit['rejected']) == 1
    assert '| E0 | 2024 | 2 | 380 |' in quality_markdown([audit])
    assert team_name('Atlético Madrid') == team_name('Ath Madrid')


def test_conflict_is_not_silently_discarded(tmp_path):
    p = tmp_path / 'input.csv'
    p.write_text('Date,HomeTeam,AwayTeam,FTHG,FTAG\n01/08/24,A,B,0,0\n01/08/24,A,B,1,0\n')
    with pytest.raises(ValueError, match='conflicting records'):
        parse_csv(p, 'E0', 2024)
