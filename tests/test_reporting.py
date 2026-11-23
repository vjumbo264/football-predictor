from footpred.backtest import predict
from footpred.betting import assess
from footpred.evaluate import evaluate
from footpred.models.ensemble import fit_weights, combine
from footpred.report import render
from test_walkforward import fake


def test_synthetic_pipeline_report_has_no_claim_for_sparse_samples():
    f=fake().assign(PSCH=2.2,PSCD=3.6,PSCA=2.9)
    p={m:predict(f,[2023],m) for m in ('market','league_prior','form','poisson')}
    p['ensemble']=combine(p,fit_weights(p,2023))
    report=render(evaluate(p,reps=10),assess(p,{'1X2':None,'OU25':None},reps=10),{'model_trials':21,'bet_trials':90})
    assert 'No convincing evidence' in report
    assert 'zero model bets is not zero ROI' in report
    assert 'Lowest observed model log loss' in report
