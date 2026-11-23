import numpy as np
import pandas as pd
import pytest
from footpred.backtest import predict
from footpred.betting import opportunities, profit, tickets, stats, learn_rules, assess
from test_walkforward import fake


def test_real_payout_edge_clv_controls_and_alignment(tmp_path):
    f=fake().assign(PSCH=2.2,PSCD=3.6,PSCA=2.9)
    p={m:predict(f,[2023],m) for m in ('market','league_prior','form')}
    o=opportunities(p['market'],p['form'])
    r=o[o.outcome==0].iloc[0]
    assert np.isclose(r.clv,2.4/2.2-1)
    assert np.isclose(r.profit,1.4 if r.hit else -1)
    assert profit(3,True)==2 and profit(3,False)==-1
    mp=np.array([float(c) for c in p['market'].iloc[0].p.strip('[]').split(',')])
    pp=float(p['form'].iloc[0].p.strip('[]').split(',')[0])
    assert np.isclose(r.edge,pp-mp[0]) and np.isclose(r.ev,pp*2.4-1)
    assert len(tickets(o,'every'))==len(o) and len(tickets(o,'favourite'))*3==len(o)
    assert stats(o,reps=20)['clv_n']==len(o)
    rules,log=learn_rules(p,2023,min_bets=75,reps=20)
    assert len(log)==18 and rules=={'1X2':None,'OU25':None}
    assert assess(p,rules,tmp_path,reps=20)['1X2']['model']['n']==0
    assert (tmp_path/'profit.png').is_file() and (tmp_path/'clv.png').is_file()
    with pytest.raises(ValueError,match='validation only'):
        learn_rules(p,2022)
