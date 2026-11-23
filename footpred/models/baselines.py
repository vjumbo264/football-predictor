from dataclasses import dataclass
import numpy as np
import pandas as pd
from scipy.optimize import brentq
from footpred.data import BOOK_1X2, BOOK_OU, MARKETS, outcomes

PINNACLE_STALE = pd.Timestamp('2025-07-23')


def demargin(odds, method='power'):
    o = np.asarray(odds, dtype=float)
    if o.ndim != 1 or len(o) < 2 or not np.isfinite(o).all() or (o <= 1).any():
        raise ValueError('decimal odds must be finite and greater than 1')
    q = 1/o
    if method == 'proportional':
        return q/q.sum()
    if method != 'power':
        raise ValueError(f'unknown method {method}')
    hi = 2.0
    while (q**hi).sum() > 1:
        hi *= 2
    p = q**brentq(lambda k: (q**k).sum()-1, 0, hi)
    return p/p.sum()


def _candidates(market, date):
    if market == 'BTTS':
        return (), ()
    one_x_two = market == '1X2'
    books = BOOK_1X2 if one_x_two else BOOK_OU
    if pd.Timestamp(date) >= PINNACLE_STALE:
        books = tuple(b for b in books if b not in {'P','PS'})
    return books, tuple('HDA') if one_x_two else ('>2.5','<2.5')


def _board(row, book, labels, close):
    prices = np.array([row.get(book+('C' if close else '')+x, np.nan) for x in labels], dtype=float)
    return prices if np.isfinite(prices).all() and (prices>1).all() else None


def bookmaker(row, market, close=False):
    """Benchmark board, preferring reliable Pinnacle then market average."""
    books, labels = _candidates(market,row['date'])
    individuals = []
    for book in books:
        b = _board(row, book, labels, close)
        if b is None or book == 'Max':
            continue
        if book in {'P','PS','Avg','BbAv'}:
            return b, book
        individuals.append(b)
    if individuals:
        return np.mean(individuals,axis=0), 'computed_avg'
    return None, None


def posted_pair(row, market):
    """Pick one actual named book using only the pre-close board; match its close.

    Never place a hypothetical bet at an average, or substitute a different
    bookmaker's close. Close may be missing without affecting bet eligibility.
    """
    books, labels = _candidates(market,row['date'])
    for book in books:
        if book in {'Avg','BbAv','Max'}:
            continue
        pre = _board(row,book,labels,False)
        if pre is not None:
            return pre, _board(row,book,labels,True), book
    return None, None, None


@dataclass
class LeaguePrior:
    prior_strength: float = 30

    def fit(self, history, cutoff):
        h = history[history.date < cutoff]
        season = cutoff.year - (cutoff.month < 7)
        labels = np.array([outcomes(x,y) for x,y in zip(h.hg,h.ag)], dtype=int).reshape(-1,3)
        current = h.season.to_numpy() == season
        self.probs = {}
        for i, (m, classes) in enumerate(MARKETS.items()):
            k = len(classes)
            previous = np.bincount(labels[~current,i],minlength=k)+1.
            count = np.bincount(labels[current,i],minlength=k)
            self.probs[m] = (count+self.prior_strength*previous/previous.sum())/(count.sum()+self.prior_strength)
        return self

    def predict(self, home, away):
        return self.probs
