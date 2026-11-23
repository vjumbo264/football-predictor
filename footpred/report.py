"""Compact Markdown reporting; do not confuse synthetic smoke tests with evidence."""

def _percent(x):
    return '—' if x is None else f'{x:.2%}'


def _ci(x, percent=False):
    if not x:
        return '—'
    f = _percent if percent else lambda y: f'{y:+.4f}'
    return f'[{f(x["lower"])}, {f(x["upper"])}]'


def render(metrics, betting, cfg):
    lines=['# Phase 1 Backtest Lab','','## What we tested','',
           'Five European leagues. Burn-in: 2020/21–2022/23. Validation: 2023/24. Held-out test: 2024/25–2025/26.',
           'Models were refit every 14 days with strictly earlier data. Teams with fewer than five prior games at refit were skipped. Headline market comparisons use identical matches with complete odds. Log loss and Brier: lower is better. ECE measures calibration error; lower is better. BTTS has no odds benchmark.',
           f'Tried {cfg["model_trials"]} model-parameter variants, one learned ensemble per market, and {cfg["bet_trials"]} betting combinations on validation. The test did not choose the settings.',
           '', '## Forecasts']
    evidence=[]; poor=[]
    for m in ('1X2','OU25','BTTS'):
        a=metrics['overall'][m]; models=a['models']; candidates={k:v for k,v in models.items() if k not in {'bookmaker_power','proportional','league_prior'}}
        lines += ['', f'### {m}', f'{a["comparison_matches"]:,} comparable matches of {a["eligible_matches"]:,} eligible.', '',
                  '| Model | Log loss | Brier | ECE |', '|---|---:|---:|---:|']
        for k,v in models.items():
            lines.append(f'| {k} | {v["log_loss"]:.4f} | {v["brier"]:.4f} | {v["ece"]:.2%} |')
        if candidates:
            best=min(candidates,key=lambda k:candidates[k]['log_loss'])
            lines += ['', f'Lowest observed model log loss: **{best}** (descriptive, not a new model selection).']
        ensemble=models.get('ensemble')
        if ensemble and m!='BTTS':
            delta=ensemble['versus_bookmaker_power']['log_loss']
            lines += [f'Ensemble minus bookmaker log loss: {delta["delta"]:+.4f} (95% week-bootstrap CI {_ci(delta["ci95"])}).']
            poor.append(ensemble['ece']>.06 and ensemble['log_loss']>=models['league_prior']['log_loss'])
            s=betting[m]['model']; brier=ensemble['versus_bookmaker_power']['brier']['ci95']
            if (delta['ci95'] and delta['ci95']['upper']<0 and brier and brier['upper']<0 and
                    s.get('roi_ci95') and s['roi_ci95']['lower']>0 and s.get('clv_ci95') and s['clv_ci95']['lower']>0):
                evidence.append(m)
    lines += ['', '## Flat-stake historical simulation','',
              '| Market / strategy | Bets | ROI (95% CI) | Mean CLV (95% CI) | Close matches |',
              '|---|---:|---:|---:|---:|']
    for m,v in betting.items():
        for k in ('model','bet_every_outcome','bet_all_favourites'):
            s=v[k]
            lines.append(f'| {m} / {k} | {s["n"]} | {_percent(s["roi"])} {_ci(s.get("roi_ci95"),True)} | {_percent(s.get("clv_mean"))} {_ci(s.get("clv_ci95"),True)} | {s["clv_n"]} |')
        if v['frozen_rule'] is None:
            lines += ['', f'**{m}**: no validation candidate met the conservative activation rule; zero model bets is not zero ROI.', '']
    if evidence:
        verdict='**(b) Evidence of an edge in '+', '.join(evidence)+' on this test.** The ensemble beat the bookmaker on both proper scores, and the locked betting strategy had positive ROI and same-book CLV intervals. Confirm prospectively before any alerts.'
    elif len(poor)==2 and all(poor):
        verdict='**(c) Calibration needs work.** The ensemble missed the prespecified ECE diagnostic in both priced markets and failed to beat the league prior on log loss. Check reliability and sample sizes before testing a revised calibration on new data.'
    else:
        verdict='**(a) No convincing evidence of a betting edge.** Use the calibration tables to judge whether probabilities are suitable to display. A good probability forecast need not survive the bookmaker margin.'
    return '\n'.join(lines+['','ROI uses actual decimal prices and one unit per ticket; no margin removal in payouts. CLV is posted odds divided by the same book’s closing odds, minus one. Missing closes are not imputed. Hit rate, win-price coverage and daily drawdown are in the results JSON.',
        '', '## Verdict','',verdict,'','## What this does not prove','',
        'One two-season holdout cannot establish persistent profit or live price availability. Weekly bootstrap intervals describe sampling variation, are not simultaneous across all league/market slices, and do not account for limits, timing, price changes or many exploratory comparisons. Quoted pre-close snapshots are not a guarantee of execution.',
        '', '## Phase 2 scope','',
        'Start in shadow mode with probability display and calibration monitoring only, in leagues with strong coverage. Do not enable betting alerts on these results alone. Keep BTTS informational.', ''])
