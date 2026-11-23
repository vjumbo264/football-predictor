import itertools
import numpy as np
import pandas as pd
import pytest
from footpred.models.poisson import GoalModel, market_probabilities, score_matrix


@pytest.mark.parametrize('rho',[0,-.09])
def test_matrix_probabilities_and_consistency(rho):
    m = score_matrix(1.65,1.1,rho,16)
    p = market_probabilities(m)
    assert m.min()>0 and np.isclose(m.sum(),1)
    assert all(np.isclose(x.sum(),1) for x in p.values())
    assert np.isclose(p['BTTS'][0],1-m[0,:].sum()-m[:,0].sum()+m[0,0])
    assert np.isclose(p['1X2'][1],np.trace(m))
    assert np.isclose(p['OU25'][1],m[0,:3].sum()+m[1,:2].sum()+m[2,0])
    assert np.allclose(m.sum(0),score_matrix(1.65,1.1,0,16).sum(0))


def synthetic():
    a = dict(a=.3,b=-.3,c=.15,d=-.15)
    d = dict(a=.2,b=.1,c=-.2,d=-.1)
    rng = np.random.default_rng(811)
    games = []
    for i,(h,v) in enumerate(list(itertools.permutations(a,2))*250):
        date = pd.Timestamp('2017-01-01')+pd.Timedelta(days=i//3)
        rates = np.exp([.15+.22+a[h]+d[v],.15+a[v]+d[h]])
        g,w = rng.poisson(rates)
        games.append((date,date.year - (date.month < 7),h,v,g,w))
    return pd.DataFrame(games,columns=['date','season','home','away','hg','ag']),a,d


def test_recovers_known_parameters():
    f,a,d = synthetic()
    fit = GoalModel(half_life=3000.).fit(f,pd.Timestamp('2020-01-01'))
    assert np.allclose(list(fit.attack_.values()),list(a.values()),atol=.085)
    assert np.allclose(list(fit.defence_.values()),list(d.values()),atol=.085)
    assert abs(fit.home_-.22)<.1


@pytest.mark.parametrize('rho',[0,-.10])
def test_no_same_day_or_future_leakage(rho):
    f,_,_ = synthetic()
    cutoff = f.date.iloc[360]
    changed = f.copy()
    changed.loc[changed.date>=cutoff,['hg','ag']] = [0,8]
    a = GoalModel(rho=rho).fit(f,cutoff).predict('a','b')
    b = GoalModel(rho=rho).fit(changed,cutoff).predict('a','b')
    for key in a:
        assert np.array_equal(a[key],b[key])
