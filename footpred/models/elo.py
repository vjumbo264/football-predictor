"""Elo ratings with chronological calibration using pre-result rating differences."""
from collections import defaultdict
from dataclasses import dataclass
import numpy as np
from scipy.optimize import minimize
from scipy.special import softmax, logsumexp, expit
from footpred.data import outcomes


@dataclass
class Elo:
    k: float = 20.
    home: float = 65.
    retention: float = .8

    def fit(self, history, cutoff):
        f = history.loc[history.date<cutoff].sort_values(['date','home','away'])
        ratings = defaultdict(float)
        gaps, obs = [], []
        season = None
        for _, chunk in f.groupby('date',sort=False):
            s = int(chunk.season.iloc[0])
            if season is not None and s != season:
                for t in ratings:
                    ratings[t] *= self.retention ** (s-season)
            season = s
            delta = defaultdict(float)
            for h,a,y,z in chunk[['home','away','hg','ag']].itertuples(index=False,name=None):
                x = (ratings[h]-ratings[a]+self.home) / 400
                labels = outcomes(y,z)
                gaps.append(x); obs.append(labels)
                actual = (1.,.5,0.)[labels[0]]
                margin = 1 + np.log1p(min(abs(y-z),4)) if y!=z else 1.
                diff = self.k*margin*(actual-expit(x*np.log(10)))
                delta[h]+=diff; delta[a]-=diff
            for t, diff in delta.items():
                ratings[t] += diff
        if not obs:
            raise ValueError('Elo requires historical matches')
        requested = cutoff.year - (cutoff.month < 7)
        self.ratings_ = {t:r*self.retention**max(0,requested-season) for t,r in ratings.items()}
        x, y = np.array(gaps), np.array(obs)

        def davidson(beta):
            l = np.column_stack((beta[0]*x,np.full(len(x),beta[1]),-beta[0]*x))
            return np.mean(logsumexp(l,axis=1)-l[np.arange(len(y)),y[:,0]])+.002*np.square(beta-[1.,0.]).sum()

        fit = minimize(davidson,[1.,0.],method='L-BFGS-B',bounds=[(.02,8),(-5,5)])
        if not fit.success:
            raise RuntimeError(f'Elo draw model failed: {fit.message}')
        self.draw_ = fit.x
        X = self.features(x)
        self.binary_ = []
        for i in (1,2):
            hit = y[:,i]==0

            def binary(beta):
                z=X@beta
                return np.mean(np.logaddexp(0,z)-hit*z)+.005*np.square(beta).sum(), X.T@(expit(z)-hit)/len(X)+.01*beta

            fit=minimize(binary,np.zeros(X.shape[1]),jac=True,method='L-BFGS-B')
            if not fit.success:
                raise RuntimeError(f'Elo binary mapping failed: {fit.message}')
            self.binary_.append(fit.x)
        return self

    @staticmethod
    def features(x):
        x=np.asarray(x)
        return np.stack((np.ones_like(x),x,np.abs(x)),axis=-1)

    def predict(self, home, away):
        x = (self.ratings_.get(home,0)-self.ratings_.get(away,0)+self.home)/400
        a,b = self.draw_
        u,v = (expit(self.features(x)@beta) for beta in self.binary_)
        return {'1X2':softmax([a*x,b,-a*x]),'OU25':np.array([u,1-u]),'BTTS':np.array([v,1-v])}
