import numpy as np
import pandas as pd
import pytest
from footpred.backtest import predict, select_models, GRID


def fake(seasons=(2022,2023)):
    rng=np.random.default_rng(173)
    rows=[]
    for s in seasons:
        for day, pairs in enumerate([[('aa','bb'),('cc','dd')],[('aa','cc'),('bb','dd')],[('aa','dd'),('bb','cc')],[('bb','aa'),('dd','cc')],[('cc','aa'),('dd','bb')],[('dd','aa'),('cc','bb')]]):
            for h,a in pairs:
                rows.append(dict(date=pd.Timestamp(f'{s}-08-01')+pd.Timedelta(days=day*7),season=s,league='E0',home=h,away=a,hg=rng.poisson(1.5),ag=rng.poisson(1.1),PSH=2.4,PSD=3.5,PSA=2.9))
    return pd.DataFrame(rows)


@pytest.mark.parametrize('model',['league_prior','poisson','dixon_coles','elo','form','market'])
def test_walkforward_earlier_predictions_ignore_scrambled_future(model):
    f=fake()
    split=pd.Timestamp('2023-08-15')
    earlier=predict(f,[2023],model)
    changed=f.copy()
    changed.loc[changed.date>=split,['hg','ag']]=[9,0]
    after=predict(changed,[2023],model)
    keys=(earlier.date<='2023-08-15')
    assert keys.any()
    assert (earlier.cutoff<=earlier.date).all()
    assert earlier[keys].p.equals(after[keys].p)


def test_validation_grid_and_resume(tmp_path):
    f=fake()
    chosen,p=select_models(f,2023,tmp_path,'synthetic')
    assert set(chosen)==set(GRID) and set(p)==set(GRID)|{'league_prior','market'}
    assert len(pd.read_csv(tmp_path/'search_log.csv'))==21
    chosen2,p2=select_models(f,2023,tmp_path,'synthetic')
    assert chosen2==chosen and p2['elo'].p.equals(p['elo'].p)
    with pytest.raises(ValueError,match='later seasons'):
        select_models(f,2022,tmp_path,'synthetic')
