import itertools
import subprocess
import numpy as np
import pandas as pd
import pytest
from footpred import pipeline
from footpred.data import parse_csv, season_code


def test_stage_separation_and_committed_freeze(tmp_path, monkeypatch):
    repo=tmp_path/'repo'; repo.mkdir(); monkeypatch.chdir(repo)
    subprocess.run(['git','init','-q'],check=True)
    pipeline.git('config','user.email','test@example.invalid')
    pipeline.git('config','user.name','Synthetic fixture')
    root=repo/'raw'; seats=('aa','bb','cc','dd'); rng=np.random.default_rng(42)
    completed=(2022,2023,2024,2025)
    monkeypatch.setattr(pipeline,'COMPLETED',completed)
    monkeypatch.setattr(pipeline,'LEAGUES',('E0',))

    def spawn(season):
        path=root/season_code(season)/'E0.csv'; path.parent.mkdir(parents=True)
        data=['Date,HomeTeam,AwayTeam,FTHG,FTAG,PSH,PSD,PSA,P>2.5,P<2.5,B365H,B365D,B365A,B365>2.5,B365<2.5']
        for i,(h,a) in enumerate(itertools.permutations(seats,2)):
            time=pd.Timestamp(f'{season}-08-01')+pd.Timedelta(days=i*7)
            g,z=rng.poisson([1.5,1.1])
            data.append(f'{time:%d/%m/%Y},{h},{a},{g},{z},2.4,3.2,3,1.9,1.95,2.4,3.2,3,1.9,1.95')
        path.write_text('\n'.join(data)+'\n')

    def load(path, seasons):
        chunks=[]; audit=[]
        for s in seasons:
            x,a=parse_csv(path/season_code(s)/'E0.csv','E0',s)
            a['expected_full_season']=12
            chunks.append(x); audit.append(a)
        return pd.concat(chunks,ignore_index=True),audit

    monkeypatch.setattr(pipeline,'load_snapshot',load)
    spawn(2022); spawn(2023)
    cf=pipeline.validation(root,repo/'validation')
    assert set(cf['training_manifest'])=={'2022/E0','2023/E0'} and cf['bet_trials']==90
    dst=repo/pipeline.FREEZE_PATH; dst.parent.mkdir(parents=True)
    dst.write_bytes((repo/'validation'/'frozen_config.json').read_bytes())
    pipeline.git('add',str(dst)); pipeline.git('commit','-qm','Synthetic validation freeze')
    freeze=pipeline.git('rev-parse','HEAD')
    spawn(2024); spawn(2025)
    real_evaluate=pipeline.evaluate
    monkeypatch.setattr(pipeline,'evaluate',lambda p,*args,**kwargs:real_evaluate(p,reps=10))
    out=repo/'official'
    pipeline.holdout(root,out,freeze)
    for k in ('REPORT.md','test_metrics.json','baselines.json','betting_test.json','provenance.json','predictions_ensemble.csv'):
        assert (out/k).stat().st_size>0
    with pytest.raises(ValueError,match='already exists'):
        pipeline.holdout(root,out,freeze)
    modified=root/'2324'/'E0.csv'
    modified.write_text(modified.read_text()+'\n')
    with pytest.raises(ValueError,match='training bytes differ'):
        pipeline.holdout(root,repo/'other',freeze)
