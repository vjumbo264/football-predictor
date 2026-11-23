"""Exponentially weighted attack/defence goal intensity fits."""
from dataclasses import dataclass
import numpy as np
from scipy.optimize import minimize
from scipy.special import gammaln
from scipy.stats import poisson


def correction(x, y, l, m, rho):
    """Dixon–Coles tau and its derivatives w.r.t. the two log intensities."""
    a, b, c, d = (x==0)&(y==0), (x==0)&(y==1), (x==1)&(y==0), (x==1)&(y==1)
    left = -a.astype(float)*l*m*rho + b*l*rho
    right = -a.astype(float)*l*m*rho + c*m*rho
    return 1 + left + c*m*rho - d*rho, left, right


def score_matrix(home_rate, away_rate, rho=0., max_goals=10):
    if min(home_rate,away_rate)<=0 or max_goals<2:
        raise ValueError('positive rates and at least two goals required')
    g = np.arange(max_goals+1)
    tau, _, _ = correction(g[:,None],g[None,:],home_rate,away_rate,rho)
    if (tau <= 0).any():
        raise ValueError('rho and rates imply nonpositive low-score weights')
    m = np.outer(poisson.pmf(g, home_rate),poisson.pmf(g, away_rate))*tau
    return m/m.sum()


def market_probabilities(matrix):
    m = matrix
    h,a = np.indices(m.shape)
    predicates = {'1X2': (h>a,h==a,h<a), 'OU25': (h+a>=3,h+a<3),
                  'BTTS': ((h>0)&(a>0),(h==0)|(a==0))}
    return {name: np.array([m[mask].sum() for mask in masks]) for name,masks in predicates.items()}


@dataclass
class GoalModel:
    half_life: float = 365.
    rho: float = 0.
    penalty: float = .45
    max_goals: int = 10
    min_eta: float = -3.
    max_eta: float = 1.7

    def fit(self, history, cutoff):
        f = history.loc[history.date<cutoff]
        if (not len(f) or self.half_life<=0 or self.penalty<=0 or abs(self.rho)>.15
                or self.min_eta>=self.max_eta or self.max_eta>1.7):
            raise ValueError('empty history or unsupported goal-model settings')
        self.index = {t:i for i,t in enumerate(sorted(set(f.home)|set(f.away)))}
        hi = f.home.map(self.index).to_numpy(); ai = f.away.map(self.index).to_numpy()
        n = len(self.index)
        y,z = f.hg.to_numpy(), f.ag.to_numpy()
        w = np.exp2(-(cutoff-f.date).dt.days.to_numpy()/self.half_life)

        def objective(beta):
            a, d = beta[2:2+n], beta[2+n:]
            e = beta[0]+beta[1]+a[hi]+d[ai]
            f = beta[0]+a[ai]+d[hi]
            l, m = np.exp(np.clip(e,self.min_eta,self.max_eta)), np.exp(np.clip(f,self.min_eta,self.max_eta))
            tau, dl, dm = correction(y,z,l,m,self.rho)
            # Penalize invalid scoreline weights for both fitted and unseen matchups.
            # Our fitted rho grid is nonpositive. The cap and |rho|<=.15 ensure tau>0.
            if (tau<=0).any():
                raise ValueError('use a nonpositive rho with this intensity cap')
            cost = np.sum(w*(l+m-y*np.log(l)-z*np.log(m)-np.log(tau)))
            g = w*(l-y-dl/tau)*((e>self.min_eta)&(e<self.max_eta))
            j = w*(m-z-dm/tau)*((f>self.min_eta)&(f<self.max_eta))
            ata = np.bincount(hi,g,minlength=n)+np.bincount(ai,j,minlength=n)
            dfa = np.bincount(ai,g,minlength=n)+np.bincount(hi,j,minlength=n)
            reg = np.r_[0.,0.,beta[2:]]
            return cost + self.penalty/2*(reg@reg), np.r_[g.sum()+j.sum(),g.sum(),ata,dfa]+self.penalty*reg

        if self.rho>np.exp(-2*self.max_eta)*.99:
            raise ValueError('positive rho would invalidate some scorelines at the rate cap')
        fit = minimize(objective,np.r_[.2,.2,np.zeros(2*n)],jac=True,method='L-BFGS-B',
                       bounds=[(-1,1),(-.7,.8)]+[(-1.5,1.5)]*(2*n), options={'maxiter':180,'ftol':1e-10})
        if not fit.success:
            raise RuntimeError(f'goal fit failed: {fit.message}')
        self.base_, self.home_ = fit.x[:2]
        self.attack_ = dict(zip(self.index,fit.x[2:2+n]))
        self.defence_ = dict(zip(self.index,fit.x[2+n:]))
        return self

    def rates(self, home, away):
        l = self.base_+self.home_+self.attack_.get(home,0.)+self.defence_.get(away,0.)
        m = self.base_+self.attack_.get(away,0.)+self.defence_.get(home,0.)
        return np.exp(np.clip([l,m],self.min_eta,self.max_eta))

    def matrix(self, home, away):
        return score_matrix(*self.rates(home,away),self.rho,self.max_goals)

    def predict(self, home, away):
        return market_probabilities(self.matrix(home,away))

    def score_log_likelihood(self, home, away, y, z):
        l,m = self.rates(home,away)
        tau,_,_ = correction(np.asarray(y),np.asarray(z),l,m,self.rho)
        return float(y*np.log(l)+z*np.log(m)-l-m-gammaln(y+1)-gammaln(z+1)+np.log(tau))
