from footpred.backtest import predict
from footpred.evaluate import evaluate
from test_walkforward import fake


def test_bookmaker_comparison_is_matched_and_btts_remains_calibration_only():
    f=fake()
    f.loc[f.date==f.date.max(),'PSH']=float('nan')
    p={m:predict(f,[2023],m) for m in ('market','league_prior','form')}
    m=evaluate(p,reps=20)
    one=m['overall']['1X2']
    assert one['comparison_matches']==one['eligible_matches']-2
    assert one['models']['form']['n']==one['models']['bookmaker_power']['n']
    assert 'versus_bookmaker_power' in one['models']['form']
    bt=m['league/E0/season/2023']['BTTS']
    assert bt['eligible_matches']==bt['comparison_matches'] and 'bookmaker_power' not in bt['models']
    assert not m['overall']['OU25']['models']
