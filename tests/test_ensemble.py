import numpy as np
import pytest
from footpred.backtest import predict
from footpred.models.ensemble import combine, fit_weights
from test_walkforward import fake


def test_ensemble_weights_are_learned_and_frozen():
    f=fake()
    p={m:predict(f,[2023],m) for m in ('poisson','form')}
    w=fit_weights(p,2023)
    assert all(np.isclose(sum(v.values()),1) and min(v.values())>=0 for v in w.values())
    out=combine(p,w)
    assert len(out)==len(p['form'])
    with pytest.raises(ValueError,match='validation slice'):
        fit_weights(p,2022)
