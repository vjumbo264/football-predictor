"""Historical flat-unit simulation at posted prices, never margin-free payouts."""
import itertools
import json
from pathlib import Path
import numpy as np
import pandas as pd
from footpred.metrics import block_ci
from footpred.models.ensemble import KEY

THRESHOLDS = tuple(itertools.product((.02,.04,.06),(.03,.06,.10)))


def profit(odds, hit):
    return odds-1 if hit else -1.


def opportunities(market_ledger, forecasts):
    f=market_ledger[KEY+['p','odds','close','book']].rename(columns={'p':'fair'})
    f=f.merge(forecasts[KEY+['p']],on=KEY,validate='one_to_one')
    f=f[f.odds.ne('') & f.fair.ne('') & f.market.ne('BTTS')]
    rows=[]
    for d in f.to_dict('records'):
        odds=np.array(json.loads(d['odds']))
        # Compare the forecast to the primary market benchmark, not to a single
        # fallback book's idiosyncratic fair price. Use named quotes for profit.
        fair=np.array(json.loads(d['fair']))
        p=np.array(json.loads(d['p']))
        clos=np.asarray(json.loads(d['close'])) if d['close'] else np.full(len(p),np.nan)
        for i in range(len(p)):
            hit=int(i==d['y'])
            rows.append({**{k:d[k] for k in KEY},'outcome':i,'book':d['book'],'hit':hit,'odds':odds[i],
                         'close':clos[i],'edge':p[i]-fair[i],'ev':p[i]*odds[i]-1,
                         'profit':profit(odds[i],hit),'close_profit':profit(clos[i],hit) if np.isfinite(clos[i]) else np.nan,
                         'clv':odds[i]/clos[i]-1,'overround':float((1/odds).sum()-1)})
    return pd.DataFrame(rows,columns=[*KEY,'outcome','book','hit','odds','close','edge','ev','profit','close_profit','clv','overround'])


def tickets(ops, rule):
    if rule is None:
        return ops.iloc[:0]
    if rule=='every':
        return ops
    if rule=='favourite':
        return ops.sort_values(['odds','outcome']).drop_duplicates(KEY)
    eligible=ops[(ops.edge>=rule[0]) & (ops.ev>=rule[1])]
    return eligible.sort_values(['ev','outcome'],ascending=[False,True]).drop_duplicates(KEY)


def stats(entries, reps=2000):
    if not len(entries):
        return {'n':0,'roi':None,'roi_ci95':None,'clv_n':0}
    matched=entries.dropna(subset=['clv'])
    daily=entries.groupby('date').profit.sum().sort_index()
    balance=np.r_[0,daily.cumsum()]
    return dict(n=len(entries),roi=float(entries.profit.mean()),profits=float(entries.profit.sum()),
                roi_ci95=block_ci(entries.profit,entries.date,reps),hit_rate=float(entries.hit.mean()),
                average_odds=float(entries.odds.mean()),max_drawdown=float((np.maximum.accumulate(balance)-balance).max()),
                mean_overround=float(entries.overround.mean()),clv_n=len(matched),
                clv_mean=float(matched.clv.mean()) if len(matched) else None,
                clv_ci95=block_ci(matched.clv,matched.date,reps),
                clv_positive=float(matched.clv.gt(0).mean()) if len(matched) else None,
                clv_positive_ci95=block_ci(matched.clv.gt(0),matched.date,reps),
                roi_pre_matched=float(matched.profit.mean()) if len(matched) else None,
                roi_close_replay=float(matched.close_profit.mean()) if len(matched) else None,
                roi_close_ci95=block_ci(matched.close_profit,matched.date,reps),
                price_sources={str(k):int(v) for k,v in entries.book.value_counts().items()})


def learn_rules(predictions, validation_season, min_bets=75, reps=500):
    """One winner or abstain per market; maximize validation bootstrap lower bound."""
    if any(not p.season.eq(validation_season).all() for p in predictions.values()):
        raise ValueError('betting thresholds use validation only')
    chosen, log={},[]
    choices=sorted(set(predictions)-{'market','league_prior'})
    boards={m:opportunities(predictions['market'],predictions[m]) for m in choices}
    for market in ('1X2','OU25'):
        chosen[market]=None
        best=0.
        for model in choices:
            subset=boards[model][boards[model].market==market]
            for edge,ev in THRESHOLDS:
                sample=tickets(subset,(edge,ev))
                interval=block_ci(sample.profit,sample.date,reps) if len(sample)>=min_bets else None
                lower=interval['lower'] if interval else None
                log.append(dict(market=market,model=model,edge=edge,ev=ev,n=len(sample),
                                roi=float(sample.profit.mean()) if len(sample) else None,roi_lower=lower))
                if lower is not None and lower>best:
                    chosen[market]=dict(model=model,rule=[edge,ev]); best=lower
    return chosen,pd.DataFrame(log)


def assess(predictions, chosen, plot_dir=None, reps=2000):
    ops={m:opportunities(predictions['market'],predictions[m]) for m in sorted(set(predictions)-{'market'})}
    out={}; selected={}
    for market, setting in chosen.items():
        name=setting['model'] if setting else 'league_prior'
        opportunity=ops[name][ops[name].market==market]
        entries=tickets(opportunity,setting['rule'] if setting else None)
        out[market]={'frozen_rule':setting,'eligible_matches':len(opportunity.drop_duplicates(KEY)),
                     'model':stats(entries,reps),'bet_every_outcome':stats(tickets(opportunity,'every'),reps),
                     'bet_all_favourites':stats(tickets(opportunity,'favourite'),reps)}
        selected[market]=entries
    if plot_dir:
        from matplotlib.figure import Figure
        out_dir=Path(plot_dir); out_dir.mkdir(parents=True,exist_ok=True)
        for k in ('profit','clv'):
            fig=Figure(figsize=(8,4),layout='constrained'); ax=fig.subplots()
            for market,f in selected.items():
                if not len(f):
                    continue
                if k=='profit':
                    c=f.groupby('date').profit.sum().sort_index().cumsum()
                    ax.plot(pd.to_datetime(c.index),c.values,label=market)
                elif f.clv.notna().any():
                    ax.hist(f.clv.dropna(),bins=20,histtype='step',label=market)
            if ax.get_legend_handles_labels()[0]:
                ax.legend()
            else:
                ax.text(.5,.5,'No eligible observations',ha='center',transform=ax.transAxes)
            ax.set_title('Daily settled cumulative profit (units)' if k=='profit' else 'Same-book posted / closing odds minus 1')
            fig.savefig(out_dir/f'{k}.png',dpi=140)
    return out
