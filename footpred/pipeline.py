"""Stage-separated command line entry points for GitHub Actions."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

import pandas as pd
from footpred.backtest import GRID, MIN_PRIOR, REFIT_DAYS, cached_prediction, code_sha, select_models, write_json
from footpred.data import COMPLETED, FORWARD, LEAGUES, load_snapshot, quality_markdown, season_code
from footpred.betting import assess, learn_rules
from footpred.evaluate import evaluate
from footpred.models.ensemble import combine, fit_weights
from footpred.report import render

VALIDATION=COMPLETED[-3]
TEST=COMPLETED[-2:]
FREEZE_PATH='results/frozen_config.json'


def manifest(audit):
    return {f'{x["season"]}/{x["league"]}':x['sha256'] for x in audit}


def fingerprint(audit):
    return hashlib.sha256(json.dumps(manifest(audit),sort_keys=True).encode()).hexdigest()


def integrity(audit):
    for x in audit:
        if x['matches'] != x['expected_full_season'] or x['rejected']:
            raise ValueError(f'Snapshot needs a documented completeness exception or correction: {x["league"]} {x["season"]} has {x["matches"]} / {x["expected_full_season"]} and {len(x["rejected"])} rejects')


def validation(root, out):
    out.mkdir(parents=True,exist_ok=True)
    f,audit=load_snapshot(root,COMPLETED[:-2]); integrity(audit)
    rules={'refit_days':REFIT_DAYS,'min_prior':MIN_PRIOR}
    chosen,p=select_models(f,VALIDATION,out,fingerprint(audit),**rules)
    weights=fit_weights(p,VALIDATION); p['ensemble']=combine(p,weights)
    betting,log=learn_rules(p,VALIDATION); log.to_csv(out/'betting_search_log.csv',index=False)
    m=evaluate(p); write_json(out/'validation_metrics.json',m)
    for market in ('1X2','OU25'):
        if not m['overall'][market]['comparison_matches']:
            raise ValueError(f'No bookmaker coverage for {market}; refusing to issue freeze.')
    cfg=dict(schema=1,stage='validation',model_version=code_sha(),validation_season=VALIDATION,
             test_seasons=list(TEST),training_manifest=manifest(audit),rules=rules,models=chosen,weights=weights,
             betting=betting,model_trials=sum(map(len,GRID.values())),bet_trials=len(log))
    write_json(out/'frozen_config.json',cfg)
    (out/'data_quality_validation.md').write_text(quality_markdown(audit))
    return cfg


def git(*args):
    return subprocess.check_output(['git',*args],text=True).strip()


def read_committed_freeze(ref):
    commit=git('rev-parse','--verify',ref+'^{commit}')
    subprocess.run(['git','merge-base','--is-ancestor',commit,'HEAD'],check=True)
    canonical=git('show',f'{commit}:{FREEZE_PATH}')
    if canonical!=git('show',f'HEAD:{FREEZE_PATH}'):
        raise ValueError('HEAD does not match the referenced committed freeze')
    cfg=json.loads(canonical)
    if (cfg.get('schema')!=1 or cfg.get('stage')!='validation' or cfg.get('model_version')!=code_sha()
            or cfg.get('test_seasons')!=list(TEST) or cfg.get('validation_season')!=VALIDATION):
        raise ValueError('configuration is not a verified freeze for this exact model code and experiment')
    return commit,cfg


def predictions(f, audit, seasons, cfg, out):
    p={}
    for m,config in {**cfg['models'],'league_prior':{},'market':{}}.items():
        p[m]=cached_prediction(f,seasons,m,config,out/f'predictions_{m}.csv',fingerprint(audit),**cfg['rules'])
    p['ensemble']=combine(p,cfg['weights']); p['ensemble'].to_csv(out/'predictions_ensemble.csv',index=False)
    return p


def checked_holdout_inputs(root,cfg):
    f,audit=load_snapshot(root,COMPLETED); integrity(audit)
    if manifest([a for a in audit if a['season']<=VALIDATION]) != cfg['training_manifest']:
        raise ValueError('historical training bytes differ from the committed freeze')
    return f,audit


def holdout(root,out,ref):
    commit,cfg=read_committed_freeze(ref)
    if (out/'test_metrics.json').exists():
        raise ValueError('test output already exists; never overwrite an official run')
    f,audit=checked_holdout_inputs(root,cfg)
    print(f'Official evaluation inputs verified: {len(f):,} matches total, including burn-in and validation')
    p=predictions(f,audit,TEST,cfg,out)
    m=evaluate(p,out/'plots'); betting=assess(p,cfg['betting'],out/'plots')
    write_json(out/'betting_test.json',betting)
    write_json(out/'provenance.json',{'freeze_commit':commit,'evaluation_commit':git('rev-parse','HEAD'),'data':manifest(audit),'test_seasons':list(TEST)})
    (out/'data_quality.md').write_text(quality_markdown(audit))
    (out/'REPORT.md').write_text(render(m,betting,cfg))
    write_json(out/'test_metrics.json',m)
    # This descriptive bookmaker audit is allowed only after the official freeze.
    h=cached_prediction(f,COMPLETED,'market',{},out/'baseline_scope'/'predictions_market.csv',fingerprint(audit),**cfg['rules'])
    b=evaluate({'market':h})
    write_json(out/'baselines.json',b)
    # Never use the current season in tuning or in the official test statistics.
    if all((root/season_code(FORWARD)/f'{l}.csv').is_file() for l in LEAGUES):
        try:
            forward,fa=load_snapshot(root,(FORWARD,))
        except ValueError:
            print('Omitted optional forward slice: at least one source did not parse.')
            return
        print('Forward completed-match counts: '+', '.join(f'{a["league"]}={a["matches"]}' for a in fa))
        if all(a['matches']>=50 and not a['rejected'] for a in fa):
            extra=predictions(pd.concat([f,forward],ignore_index=True),audit+fa,(FORWARD,),cfg,out/'forward')
            write_json(out/'forward_metrics.json',{'label':'2026/27 extra forward slice, excluded from official test','metrics':evaluate(extra,out/'forward'/'plots')})
        else:
            print('Omitted optional forward slice: the 50-per-league or no-reject gate was not met.')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('stage',choices=['audit-training','validate','verify-freeze','preflight','holdout'])
    p.add_argument('--data',type=Path,default=Path('data/raw'))
    p.add_argument('--out',type=Path,default=Path('results/local'))
    p.add_argument('--freeze-commit')
    a=p.parse_args()
    if a.stage=='audit-training':
        f,audit=load_snapshot(a.data,COMPLETED[:-2]); integrity(audit)
        print(f'{len(audit)} training inputs, {len(f):,} matches; all completeness checks passed')
    elif a.stage=='validate':
        validation(a.data,a.out)
    elif not a.freeze_commit:
        p.error('--freeze-commit is required')
    elif a.stage=='verify-freeze':
        print(read_committed_freeze(a.freeze_commit)[0])
    elif a.stage=='preflight':
        _,cfg=read_committed_freeze(a.freeze_commit)
        checked_holdout_inputs(a.data,cfg)
        print('Frozen training hashes and completed-season input integrity verified; no scores calculated')
    else:
        holdout(a.data,a.out,a.freeze_commit)


if __name__=='__main__':
    main()
