import numpy as np
import pandas as pd
import pytest
from footpred.models.elo import Elo
from footpred.models.form import RecentForm


def sample():
    dates=pd.date_range('2022-08-01',periods=440,freq='D')
    rng=np.random.default_rng(99)
    return pd.DataFrame(dict(date=dates,season=np.where(dates<'2023-07-01',2022,2023),
                             home=np.where(np.arange(len(dates))%2,'a','b'),
                             away=np.where(np.arange(len(dates))%2,'b','a'),
                             hg=rng.poisson(1.5,len(dates)),ag=rng.poisson(1.1,len(dates))))


@pytest.mark.parametrize('model',[Elo,RecentForm])
def test_dynamic_valid_and_no_leakage(model):
    f=sample(); cutoff=f.date.iloc[401]
    future=f.copy(); future.loc[future.date>=cutoff,['hg','ag']]=[12,0]
    a=model().fit(f,cutoff).predict('a','b'); b=model().fit(future,cutoff).predict('a','b')
    for key in a:
        assert np.all(a[key]>0) and np.isclose(a[key].sum(),1)
        assert np.array_equal(a[key],b[key])


def test_elo_season_retention_and_blowout_cap():
    f=sample().iloc[:240]
    a=Elo(retention=.8).fit(f,pd.Timestamp('2023-06-30'))
    b=Elo(retention=.8).fit(f,pd.Timestamp('2023-07-01'))
    assert np.isclose(b.ratings_['a'],.8*a.ratings_['a'])
    f.loc[f.index[-1],['hg','ag']]=[5,0]
    a=Elo().fit(f,pd.Timestamp('2023-07-01'))
    f.loc[f.index[-1],['hg','ag']]=[20,0]
    b=Elo().fit(f,pd.Timestamp('2023-07-01'))
    assert a.ratings_==b.ratings_


def test_form_uses_goals_and_venue():
    f=sample()
    cutoff=f.date.max()+pd.Timedelta(days=1)
    a=RecentForm().fit(f,cutoff).rates('a','b')
    f.loc[f.index[-1],['hg','ag']]=[8,3]
    b=RecentForm().fit(f,cutoff).rates('a','b')
    assert not np.allclose(a,b)
