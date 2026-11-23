import numpy as np
import pandas as pd
from footpred.metrics import scores, paired, reliability_diagram
from footpred.models.baselines import demargin, bookmaker, posted_pair, LeaguePrior


def test_proper_scores_and_calibration(tmp_path):
    p = [[.75,.25],[.25,.75]]
    result = scores(p,[0,1])
    assert np.isclose(result['log_loss'],-np.log(.75))
    assert np.isclose(result['brier'],.125)
    assert result['ece']==.25 and result['accuracy']==1
    dates=pd.to_datetime(['2024-01-01','2024-01-08'])
    delta=paired(p,p,[0,1],dates,reps=20)
    assert delta['log_loss']['ci95']==dict(lower=0,upper=0,weeks=2)
    reliability_diagram({'model':result},['Yes','No'],tmp_path/'test.png')
    assert (tmp_path/'test.png').stat().st_size>1000


def test_three_way_and_demargin():
    p = [[.5,.3,.2]]
    assert np.isclose(scores(p,[1])['brier'],.25+.49+.04)
    assert np.allclose(demargin([2,3,6],'proportional'),[.5,1/3,1/6])
    assert np.allclose(demargin([2,3,6],'power'),[.5,1/3,1/6])
    assert np.isclose(demargin([1.9,3,5],'power').sum(),1)
    assert np.isclose(demargin([2.5,2.5],'power').sum(),1)


def test_market_and_posted_fallback():
    row = dict(date='2025-08-01',PSH=2,PSD=3,PSA=4,AvgH=2.1,AvgD=3.1,AvgA=4.1,
               B365H=2.2,B365D=3.2,B365A=4.2,PSCH=1.9,PSCD=2.9,PSCA=3.9)
    assert bookmaker(row,'1X2')[1]=='Avg'
    pre, close, source = posted_pair(row,'1X2')
    assert source=='B365' and close is None and np.allclose(pre,[2.2,3.2,4.2])
    row['date']='2025-05-01'
    assert bookmaker(row,'1X2')[1]=='PS'
    assert np.allclose(posted_pair(row,'1X2')[1],[1.9,2.9,3.9])
    assert bookmaker(row,'BTTS')==(None,None)


def test_league_prior_ignores_same_day():
    history = pd.DataFrame(dict(date=pd.to_datetime(['2023-05-01','2023-09-01']),season=[2022,2023],hg=[1,0],ag=[0,1]))
    p=LeaguePrior().fit(history,pd.Timestamp('2023-09-01')).predict('a','b')
    assert np.allclose(p['1X2'],[.5,.25,.25])
