"""Venue-split, exponentially weighted goals with shrinkage to league means."""
from collections import defaultdict
from dataclasses import dataclass
import numpy as np
from footpred.models.poisson import market_probabilities, score_matrix


@dataclass
class RecentForm:
    window: int = 10
    shrinkage: float = 3.
    half_life_games: float = 5.

    def fit(self, history, cutoff):
        f = history.loc[history.date<cutoff].sort_values(['date','home','away'])
        if not len(f) or min(self.window,self.shrinkage,self.half_life_games)<=0:
            raise ValueError('missing form history or invalid settings')
        self.home_mean_,self.away_mean_=(f[['hg','ag']].sum().to_numpy()+[1.5,1.2])/(len(f)+1)
        logs=defaultdict(list)
        for h,a,y,z in f[['home','away','hg','ag']].itertuples(index=False,name=None):
            logs[h,'H'].append((y,z))
            logs[a,'A'].append((z,y))
        self.form_ = {}
        for (team,venue), log in logs.items():
            prior = [self.home_mean_,self.away_mean_] if venue=='H' else [self.away_mean_,self.home_mean_]
            values=np.array(log[-self.window:][::-1])
            w=np.exp2(-np.arange(len(values))/self.half_life_games)
            self.form_[team,venue]=(w@values+self.shrinkage*np.array(prior))/(w.sum()+self.shrinkage)
        return self

    def rates(self, home, away):
        h,a=self.home_mean_,self.away_mean_
        hg,ha=self.form_.get((home,'H'),(h,a))
        ag,aa=self.form_.get((away,'A'),(a,h))
        return (np.sqrt(hg*aa),np.sqrt(ag*ha))

    def predict(self, home, away):
        return market_probabilities(score_matrix(*self.rates(home,away)))
