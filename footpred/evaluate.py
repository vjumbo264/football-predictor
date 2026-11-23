"""Matched-sample benchmarking, coverage, and reliability outputs."""
import json
from pathlib import Path
import numpy as np
from footpred.data import MARKETS
from footpred.metrics import paired, reliability_diagram, scores
from footpred.models.ensemble import KEY, aligned


def evaluate(predictions, plot_dir=None, reps=2000):
    names = sorted(set(predictions)-{'market'})
    f = aligned({**predictions,'bookmaker_power':predictions['market']},[*names,'bookmaker_power'])
    f = f.merge(predictions['market'][KEY+['proportional','source']],on=KEY,validate='one_to_one')
    out={}
    slices=[('overall',f)]
    slices.extend((f'league/{k}',v) for k,v in f.groupby('league'))
    slices.extend((f'season/{k}',v) for k,v in f.groupby('season'))
    slices.extend((f'league/{k}/season/{s}',v) for (k,s),v in f.groupby(['league','season']))
    for group, frame in slices:
        out[group]={}
        for market, labels in MARKETS.items():
            eligible=frame[frame.market==market]
            candidate_names=names if market=='BTTS' else [*names,'bookmaker_power','proportional']
            paired_frame=eligible if market=='BTTS' else eligible[eligible.bookmaker_power.ne('')]
            by_model={}
            if len(paired_frame):
                ps={m:np.array([json.loads(p) for p in paired_frame[m]]) for m in candidate_names}
                y=paired_frame.y.to_numpy()
                for m,p in ps.items():
                    entry=scores(p,y)
                    if 'bookmaker_power' in ps and m not in {'bookmaker_power','proportional'}:
                        entry['versus_bookmaker_power']=paired(p,ps['bookmaker_power'],y,paired_frame.date,reps)
                    by_model[m]=entry
                if plot_dir:
                    p=Path(plot_dir)/(group.replace('/','_')+'_'+market+'.png')
                    p.parent.mkdir(parents=True,exist_ok=True)
                    reliability_diagram(by_model,labels,p)
            out[group][market]={'eligible_matches':len(eligible),'comparison_matches':len(paired_frame),
                                'price_sources':{str(k):int(v) for k,v in paired_frame.source.value_counts().items() if k},
                                'models':by_model}
    return out
