"""Per-market validation-only convex probability mixtures."""
import json
import numpy as np
from scipy.optimize import minimize
from footpred.data import MARKETS
from footpred.backtest import encode

KEY = ['date','league','season','home','away','cutoff','market','y']


def aligned(predictions, models):
    result=None
    for name in models:
        f=predictions[name][KEY+['p']].rename(columns={'p':name})
        if result is None:
            result=f.copy()
        else:
            result=result.merge(f,on=KEY,validate='one_to_one',how='outer',indicator=True)
            if not (result.pop('_merge')=='both').all():
                raise ValueError(f'Prediction ledger mismatch: {name}')
    if result is None or not len(result) or result.duplicated(KEY).any():
        raise ValueError('empty or duplicate prediction keys')
    return result


def _tensor(f, models):
    return np.stack([np.array([json.loads(s) for s in f[m]]) for m in models],axis=1)


def fit_weights(predictions, validation_season):
    models=sorted(set(predictions)-{'market','league_prior'})
    f=aligned(predictions,models)
    if not f.season.eq(validation_season).all():
        raise ValueError('ensemble fits only on the declared validation slice')
    weights={}
    for market in MARKETS:
        m=f[f.market==market]
        t=_tensor(m,models)
        p=t[np.arange(len(m)),:,m.y.to_numpy(dtype=int)]
        n=len(models)

        def loss(w):
            q=np.clip(p@w,1e-15,1)
            return -np.log(q).mean(), -(p.T@(1/q))/len(q)

        fit=minimize(loss,np.ones(n)/n,jac=True,method='SLSQP',bounds=[(0,1)]*n,
                     constraints={'type':'eq','fun':lambda w:w.sum()-1,'jac':lambda w:np.ones_like(w)},
                     options={'ftol':1e-10,'maxiter':200})
        if not fit.success:
            raise RuntimeError(f'Ensemble fit failed: {fit.message}')
        w=np.maximum(fit.x,0)
        weights[market]=dict(zip(models,(w/w.sum()).tolist()))
    return weights


def combine(predictions, weights):
    results=[]
    for market, w in weights.items():
        models=list(w)
        vector=np.array(list(w.values()))
        if np.any(vector<0) or not np.isclose(vector.sum(),1):
            raise ValueError('ensemble weights must be a simplex')
        f=aligned(predictions,models)
        f=f[f.market==market].copy()
        f['p']=[encode(p) for p in np.einsum('nmk,m->nk',_tensor(f,models),vector)]
        results.append(f[KEY+['p']])
    import pandas as pd
    return pd.concat(results,ignore_index=True)
