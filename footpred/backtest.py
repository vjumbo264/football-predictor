"""Chronological prediction ledger and validation-only model selection."""
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd
from footpred.data import MARKETS, outcomes
from footpred.models.baselines import LeaguePrior, bookmaker, demargin, posted_pair
from footpred.models.elo import Elo
from footpred.models.form import RecentForm
from footpred.models.poisson import GoalModel

MODELS = {'league_prior': LeaguePrior, 'poisson': GoalModel, 'dixon_coles': GoalModel,
          'elo': Elo, 'form': RecentForm}
GRID = {'poisson': [{'half_life': h} for h in (365,180,730)],
        'dixon_coles': [{'half_life': h, 'rho': r} for h,r in itertools.product((365,180,730),(0.,-.06,-.12))],
        'elo': [{'k': k, 'home': h} for k,h in itertools.product((20,12,32),(65,40))],
        'form': [{'window': v} for v in (10,6,16)]}
REFIT_DAYS = 14
MIN_PRIOR = 5


def write_json(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(content,indent=2,sort_keys=True,allow_nan=False)+'\n')
    temp.replace(path)


def build_ledger(frame, seasons, refit_days=REFIT_DAYS, min_prior=MIN_PRIOR):
    """Per-league fixed calendar refits; don't update on the match or refit day.

    Refit buckets start July 1 each season. Prior-team eligibility is evaluated
    as of the refit, conservatively ignoring results since that refit.
    """
    if refit_days<1 or min_prior<1:
        raise ValueError('invalid walk-forward settings')
    for league, whole in frame.groupby('league', sort=True):
        whole=whole.sort_values(['date','home','away'])
        targets=whole[whole.season.isin(seasons)].copy()
        starts=pd.to_datetime(targets.season.astype(str)+'-07-01')
        targets['cutoff']=starts+pd.to_timedelta(((targets.date-starts).dt.days//refit_days)*refit_days,unit='D')
        for cutoff, batch in targets.groupby('cutoff',sort=True):
            past=whole.loc[whole.date<cutoff,['date','season','home','away','hg','ag']]
            counts=pd.concat([past.home,past.away]).value_counts()
            batch=batch[batch.home.map(counts).ge(min_prior)&batch.away.map(counts).ge(min_prior)]
            if len(batch):
                yield league,cutoff,past,batch


def encode(v):
    return json.dumps(np.asarray(v).tolist(),separators=(',',':')) if v is not None else ''


def predict(frame, seasons, model, settings=None, *, refit_days=REFIT_DAYS, min_prior=MIN_PRIOR):
    rows=[]
    for league,cutoff,past,batch in build_ledger(frame,seasons,refit_days,min_prior):
        fitted=MODELS[model](**(settings or {})).fit(past,cutoff) if model in MODELS else None
        for row in batch.to_dict('records'):
            p=fitted.predict(row['home'],row['away']) if fitted else {}
            y=outcomes(row['hg'],row['ag'])
            ll=None
            if isinstance(fitted,GoalModel):
                ll=fitted.score_log_likelihood(row['home'],row['away'],row['hg'],row['ag'])
            for i, m in enumerate(MARKETS):
                obs=dict(date=row['date'].strftime('%Y-%m-%d'), league=league, season=row['season'],
                         home=row['home'],away=row['away'],cutoff=cutoff.strftime('%Y-%m-%d'),market=m,y=y[i])
                if model=='market':
                    board, src=bookmaker(row,m)
                    odds, close, book=posted_pair(row,m)
                    obs.update(p=encode(demargin(board) if board is not None else None),
                               proportional=encode(demargin(board,'proportional') if board is not None else None),
                               board=encode(board), source=src or '', book=book or '', odds=encode(odds), close=encode(close))
                else:
                    obs.update(p=encode(p[m]), score_ll=ll)
                rows.append(obs)
    if not rows:
        raise ValueError(f'No eligible matches: {seasons}, {model}')
    return pd.DataFrame(rows)


def code_sha():
    code_root=Path(__file__).parent
    h=hashlib.sha256()
    for path in sorted(code_root.rglob('*.py')):
        h.update(str(path.relative_to(code_root)).encode()+b'\0'+path.read_bytes())
    return h.hexdigest()


def cached_prediction(frame, seasons, model, settings, target, fingerprint, **rules):
    target=Path(target)
    target.parent.mkdir(parents=True,exist_ok=True)
    key={'source':fingerprint,'code':code_sha(),'seasons':list(seasons),'model':model,'settings':settings,'rules':rules}
    side=target.with_suffix('.meta.json')
    if side.exists() and target.exists():
        previous=json.loads(side.read_text())
        if previous.get('key')==key and previous.get('sha256')==hashlib.sha256(target.read_bytes()).hexdigest():
            return pd.read_csv(target,keep_default_na=False)
    p=predict(frame,seasons,model,settings,**rules)
    tmp=target.with_suffix('.tmp')
    p.to_csv(tmp,index=False)
    tmp.replace(target)
    write_json(side,{'key':key,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
    return p


def market_loss(p):
    chosen=np.array([json.loads(s)[int(y)] for s,y in zip(p.p,p.y)])
    loss=-np.log(np.clip(chosen,1e-15,1))
    # Average the three market means equally; no odds required for model selection.
    return float(pd.DataFrame({'market':p.market,'loss':loss}).groupby('market').loss.mean().mean())


def select_models(frame, validation_season, output, fingerprint, grid=GRID, **rules):
    if (frame.season>validation_season).any():
        raise ValueError('validation runner refuses data from later seasons')
    output=Path(output)
    chosen, predictions, rows = {}, {}, []
    for model, variants in grid.items():
        best=float('inf')
        for i, cfg in enumerate(variants):
            p=cached_prediction(frame,(validation_season,),model,cfg,output/'cache'/f'{model}_{i}.csv',fingerprint,**rules)
            score=float(-p.loc[p.market=='1X2','score_ll'].mean()) if model in ('poisson','dixon_coles') else market_loss(p)
            rows.append(dict(model=model,candidate=i,settings=json.dumps(cfg,sort_keys=True),objective='scoreline_nll' if model in ('poisson','dixon_coles') else 'market_macro_logloss',score=score,n=len(p)//3))
            # Simpler grid entry wins differences within 0.0001 nats.
            if score<best-.0001:
                best=score
                chosen[model]=cfg
                predictions[model]=p
    for model in ('league_prior','market'):
        predictions[model]=cached_prediction(frame,(validation_season,),model,{},output/'cache'/f'{model}.csv',fingerprint,**rules)
    pd.DataFrame(rows).to_csv(output/'search_log.csv',index=False)
    return chosen,predictions
