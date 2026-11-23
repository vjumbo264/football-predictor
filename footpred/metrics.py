"""Proper scores, classwise reliability and paired calendar-week bootstrap."""
import numpy as np
import pandas as pd


def losses(probs, observed):
    p, y = np.asarray(probs, dtype=float), np.asarray(observed, dtype=int)
    if (p.ndim != 2 or len(p) == 0 or y.shape != (len(p),) or not np.isfinite(p).all()
            or (p < 0).any() or not np.allclose(p.sum(1), 1) or not ((0 <= y) & (y < p.shape[1])).all()):
        raise ValueError('invalid probability matrix or outcome labels')
    onehot = np.eye(p.shape[1])[y]
    return {'log_loss': -np.log(np.clip(p[np.arange(len(y)), y], 1e-15, 1)),
            'brier': np.square(p-onehot).sum(1), 'accuracy': (p.argmax(1)==y).astype(float)}


def scores(probs, observed, bins=10):
    p, y = np.asarray(probs), np.asarray(observed)
    out = {k: float(v.mean()) for k,v in losses(p,y).items()}
    table, weighted = [], 0.0
    bin_index = np.minimum((p*bins).astype(int), bins-1)
    for outcome in range(p.shape[1]):
        for i in range(bins):
            m = bin_index[:,outcome] == i
            n = int(m.sum())
            forecast = float(p[m,outcome].mean()) if n else None
            actual = float(np.mean(y[m] == outcome)) if n else None
            if n:
                weighted += n * abs(forecast-actual)
            table.append(dict(outcome=outcome, bin=i, lower=i/bins, upper=(i+1)/bins,
                              n=n, mean_probability=forecast, observed_frequency=actual))
    return dict(n=len(y), **out, ece=weighted/p.size, reliability=table)


def block_ci(values, dates, reps=2000, seed=2026):
    """Resample whole Monday–Sunday weeks; sums/row counts estimate per-row means."""
    values = np.asarray(values, dtype=float)
    if not len(values):
        return None
    week = pd.DatetimeIndex(dates).to_period('W-SUN')
    if len(week) != len(values) or week.isna().any() or not np.isfinite(values).all():
        raise ValueError('non-finite or misaligned bootstrap inputs')
    blocks = pd.DataFrame({'week': week, 'v': values}).groupby('week')['v'].agg(['sum','size'])
    n = len(blocks)
    if n < 2:
        return None
    idx = np.random.default_rng(seed).integers(0,n,size=(reps,n))
    draws = blocks['sum'].to_numpy()[idx].sum(1) / blocks['size'].to_numpy()[idx].sum(1)
    return dict(lower=float(np.quantile(draws,.025)), upper=float(np.quantile(draws,.975)), weeks=n)


def paired(model, benchmark, observed, dates, reps=2000):
    a, b = losses(model, observed), losses(benchmark, observed)
    return {k: dict(delta=float((a[k]-b[k]).mean()), ci95=block_ci(a[k]-b[k],dates,reps))
            for k in ('log_loss','brier')}


def reliability_diagram(by_model, labels, path):
    from matplotlib.figure import Figure
    fig = Figure(figsize=(4*len(labels),4), layout='constrained')
    axes = fig.subplots(1,len(labels),squeeze=False)[0]
    for j, (label, ax) in enumerate(zip(labels, axes)):
        ax.plot([0,1],[0,1],linestyle=':',color='gray')
        for name, model in by_model.items():
            bins = [b for b in model['reliability'] if b['outcome'] == j and b['n']]
            ax.plot([b['mean_probability'] for b in bins],[b['observed_frequency'] for b in bins],marker='.',label=name)
        ax.set(xlim=(0,1),ylim=(0,1),title=label,xlabel='Mean forecast',ylabel='Actual rate')
    axes[-1].legend(fontsize=7)
    fig.savefig(path,dpi=140)
