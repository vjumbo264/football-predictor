import type { Outcome, TeamStrengthSnapshot } from './types';

function poissonPmf(k: number, lambda: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) {
    p = (p * lambda) / i;
  }
  return p;
}

function tau(x: number, y: number, l: number, m: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - l * m * rho;
  if (x === 0 && y === 1) return 1 + l * rho;
  if (x === 1 && y === 0) return 1 + m * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

export interface ProvisionalEstimate {
  p_home: number;
  p_draw: number;
  p_away: number;
  xg_home: number;
  xg_away: number;
  predicted_outcome: Outcome;
  summary_reason: string;
}

export function computeProvisionalEstimate(
  snapshot: TeamStrengthSnapshot,
  homeCanon: string,
  awayCanon: string,
): ProvisionalEstimate {
  const h = snapshot.teams[homeCanon] ?? { attack: 0, defence: 0, elo: 0 };
  const a = snapshot.teams[awayCanon] ?? { attack: 0, defence: 0, elo: 0 };
  const etaH = Math.max(-3, Math.min(1.7, snapshot.base + snapshot.home_adv + h.attack + a.defence));
  const etaA = Math.max(-3, Math.min(1.7, snapshot.base + a.attack + h.defence));
  const l = Math.exp(etaH);
  const m = Math.exp(etaA);

  const maxGoals = 10;
  let sum = 0;
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;

  for (let i = 0; i <= maxGoals; i++) {
    const pi = poissonPmf(i, l);
    for (let j = 0; j <= maxGoals; j++) {
      const pj = poissonPmf(j, m);
      const w = Math.max(1e-6, pi * pj * tau(i, j, l, m, snapshot.rho));
      sum += w;
      if (i > j) pHome += w;
      else if (i === j) pDraw += w;
      else pAway += w;
    }
  }

  pHome /= sum;
  pDraw /= sum;
  pAway /= sum;

  const predicted_outcome: Outcome =
    pHome >= pDraw && pHome >= pAway ? 'H' : pDraw >= pAway ? 'D' : 'A';

  const gap = [pHome, pDraw, pAway].sort((x, y) => y - x);
  const summary_reason =
    gap[0] - gap[1] < 0.08
      ? 'Tight matchup on team attack/defence ratings; draw risk elevated.'
      : predicted_outcome === 'H'
        ? `Home edge (${l.toFixed(2)} vs ${m.toFixed(2)} xG; Elo ${Math.round(h.elo - a.elo) >= 0 ? '+' : ''}${Math.round(h.elo - a.elo)}).`
        : predicted_outcome === 'A'
          ? `Away edge (${m.toFixed(2)} vs ${l.toFixed(2)} xG; Elo ${Math.round(a.elo - h.elo) >= 0 ? '+' : ''}${Math.round(a.elo - h.elo)}).`
          : `Balanced expected scoring (${l.toFixed(2)} vs ${m.toFixed(2)} xG).`;

  return {
    p_home: pHome,
    p_draw: pDraw,
    p_away: pAway,
    xg_home: l,
    xg_away: m,
    predicted_outcome,
    summary_reason,
  };
}
