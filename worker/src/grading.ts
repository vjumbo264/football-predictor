import { fetchFinishedScores, type FetchLike } from './sources';
import type { Env, Outcome } from './types';

export interface GradingSummary {
  due_checked: number;
  results_recorded: number;
  predictions_graded: number;
  api_fetched: boolean;
}

export function computeBrierScore(
  pHome: number,
  pDraw: number,
  pAway: number,
  actual: Outcome,
): number {
  const yH = actual === 'H' ? 1 : 0;
  const yD = actual === 'D' ? 1 : 0;
  const yA = actual === 'A' ? 1 : 0;
  return (pHome - yH) ** 2 + (pDraw - yD) ** 2 + (pAway - yA) ** 2;
}

export function computeLogLoss(
  pHome: number,
  pDraw: number,
  pAway: number,
  actual: Outcome,
): number {
  const p = actual === 'H' ? pHome : actual === 'D' ? pDraw : pAway;
  return -Math.log(Math.max(p, 1e-15));
}

export async function runGradingPass(
  env: Env,
  nowIso: string = new Date().toISOString(),
  fetchFn: FetchLike = fetch,
): Promise<GradingSummary> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const cutoffIso = new Date(Date.parse(nowIso) - 105 * 60 * 1000).toISOString();

  // 1. Check fixtures past kickoff + 105m not yet FT (cheap D1 query)
  const { results: dueFixtures } = await env.DB
    .prepare(
      `SELECT match_id FROM fixtures
       WHERE league = ? AND status IN ('NS', 'LIVE') AND kickoff_utc <= ?`,
    )
    .bind(league, cutoffIso)
    .all<{ match_id: string }>();

  // 2. Also check any predictions whose results are already in D1 but not yet graded
  const { results: preExistingUngraded } = await env.DB
    .prepare(
      `SELECT p.id FROM predictions p
       JOIN results r ON r.match_id = p.match_id
       LEFT JOIN prediction_results pr ON pr.prediction_id = p.id
       WHERE pr.id IS NULL`,
    )
    .all<{ id: number }>();

  if (!dueFixtures.length && !preExistingUngraded.length) {
    return {
      due_checked: 0,
      results_recorded: 0,
      predictions_graded: 0,
      api_fetched: false,
    };
  }

  let resultsRecorded = 0;
  let apiFetched = false;
  if (dueFixtures.length > 0) {
    apiFetched = true;
    const dueIds = new Set(dueFixtures.map((f) => f.match_id));
    const finished = await fetchFinishedScores(env, dueIds, nowIso, fetchFn);
    for (const item of finished) {
      const actual: Outcome =
        item.home_goals > item.away_goals
          ? 'H'
          : item.away_goals > item.home_goals
            ? 'A'
            : 'D';
      const ins = await env.DB
        .prepare(
          `INSERT INTO results (match_id, home_goals, away_goals, actual_outcome, status, source, recorded_at)
           VALUES (?, ?, ?, ?, 'FT', ?, ?)
           ON CONFLICT (match_id) DO NOTHING`,
        )
        .bind(
          item.match_id,
          item.home_goals,
          item.away_goals,
          actual,
          item.source,
          nowIso,
        )
        .run();
      if ((ins.meta?.changes ?? 0) > 0) {
        resultsRecorded += 1;
      }
      await env.DB
        .prepare("UPDATE fixtures SET status = 'FT', updated_at = ? WHERE match_id = ? AND status != 'FT'")
        .bind(nowIso, item.match_id)
        .run();
    }
  }

  // 3. Append-only grading for every ungraded prediction that now has a result
  const { results: toGrade } = await env.DB
    .prepare(
      `SELECT p.id AS prediction_id, p.match_id, p.p_home, p.p_draw, p.p_away,
              p.predicted_outcome, r.actual_outcome
       FROM predictions p
       JOIN results r ON r.match_id = p.match_id
       LEFT JOIN prediction_results pr ON pr.prediction_id = p.id
       WHERE pr.id IS NULL`,
    )
    .all<{
      prediction_id: number;
      match_id: string;
      p_home: number;
      p_draw: number;
      p_away: number;
      predicted_outcome: Outcome;
      actual_outcome: Outcome;
    }>();

  let predictionsGraded = 0;
  for (const row of toGrade) {
    const isCorrect = row.predicted_outcome === row.actual_outcome ? 1 : 0;
    const brier = computeBrierScore(row.p_home, row.p_draw, row.p_away, row.actual_outcome);
    const logLoss = computeLogLoss(row.p_home, row.p_draw, row.p_away, row.actual_outcome);
    const res = await env.DB
      .prepare(
        `INSERT OR IGNORE INTO prediction_results (
           prediction_id, match_id, predicted_outcome, actual_outcome,
           is_correct, brier_score, log_loss, graded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.prediction_id,
        row.match_id,
        row.predicted_outcome,
        row.actual_outcome,
        isCorrect,
        brier,
        logLoss,
        nowIso,
      )
      .run();
    if ((res.meta?.changes ?? 0) > 0) {
      predictionsGraded += 1;
    }
  }

  return {
    due_checked: dueFixtures.length,
    results_recorded: resultsRecorded,
    predictions_graded: predictionsGraded,
    api_fetched: apiFetched,
  };
}

interface SettledRow {
  kickoff_utc: string;
  p_home: number;
  p_draw: number;
  p_away: number;
  actual_outcome: Outcome;
  is_correct: number;
  brier_score: number;
  log_loss: number;
}

function fmtPct(num: number, den: number): string {
  if (!den) return '—';
  return `${((num / den) * 100).toFixed(1)}%`;
}

export async function handlePerformanceCommand(
  env: Env,
  nowIso: string = new Date().toISOString(),
): Promise<string> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const { results: rows } = await env.DB
    .prepare(
      `SELECT f.kickoff_utc, p.p_home, p.p_draw, p.p_away,
              pr.actual_outcome, pr.is_correct, pr.brier_score, pr.log_loss
       FROM prediction_results pr
       JOIN predictions p ON p.id = pr.prediction_id
       JOIN fixtures f ON f.match_id = pr.match_id
       WHERE f.league = ?
       ORDER BY f.kickoff_utc DESC`,
    )
    .bind(league)
    .all<SettledRow>();

  const footer = '<i>Statistical estimates only, not guarantees. Betting carries risk.</i>';

  if (!rows.length) {
    return [
      '<b>Model Performance (Premier League)</b>',
      'Settled predictions: <b>0</b>',
      '',
      'No pre-match predictions have finished and settled yet. Accuracy, always-home baseline, Brier score, log loss, and calibration will appear once locked matches finish.',
      '',
      footer,
    ].join('\n');
  }

  const nowMs = Date.parse(nowIso);
  const cutoff7d = nowMs - 7 * 24 * 3600_000;
  const cutoff30d = nowMs - 30 * 24 * 3600_000;

  let hitsAll = 0;
  let homeAll = 0;
  let brierSum = 0;
  let logLossSum = 0;

  let n7 = 0;
  let hits7 = 0;
  let home7 = 0;

  let n30 = 0;
  let hits30 = 0;
  let home30 = 0;

  const buckets: Array<{ label: string; min: number; max: number; n: number; hits: number }> = [
    { label: 'Under 45%', min: 0, max: 0.45, n: 0, hits: 0 },
    { label: '45–55%', min: 0.45, max: 0.55, n: 0, hits: 0 },
    { label: '55–65%', min: 0.55, max: 0.65, n: 0, hits: 0 },
    { label: '65%+', min: 0.65, max: 1.01, n: 0, hits: 0 },
  ];

  for (const r of rows) {
    const koMs = Date.parse(r.kickoff_utc);
    const hit = r.is_correct === 1 ? 1 : 0;
    const homeHit = r.actual_outcome === 'H' ? 1 : 0;
    hitsAll += hit;
    homeAll += homeHit;
    brierSum += r.brier_score;
    logLossSum += r.log_loss;

    if (koMs >= cutoff7d) {
      n7 += 1;
      hits7 += hit;
      home7 += homeHit;
    }
    if (koMs >= cutoff30d) {
      n30 += 1;
      hits30 += hit;
      home30 += homeHit;
    }

    const topProb = Math.max(r.p_home, r.p_draw, r.p_away);
    const bucket = buckets.find((b) => topProb >= b.min && topProb < b.max) ?? buckets[buckets.length - 1];
    bucket.n += 1;
    bucket.hits += hit;
  }

  const n = rows.length;
  const lines: string[] = [
    '<b>Model Performance (Premier League)</b>',
    `Based on <b>${n}</b> settled pre-match prediction${n === 1 ? '' : 's'}.`,
    '',
    `<b>Overall (${n} matches):</b>`,
    `• Bot accuracy: <b>${fmtPct(hitsAll, n)}</b> (${hitsAll}/${n})`,
    `• Always-home baseline: ${fmtPct(homeAll, n)} (${homeAll}/${n})`,
    `• Mean Brier score: ${(brierSum / n).toFixed(4)} (lower is better)`,
    `• Mean Log loss: ${(logLossSum / n).toFixed(4)} (lower is better)`,
    '',
    `<b>Recent windows:</b>`,
    `• Last 7 days (${n7}): Bot ${fmtPct(hits7, n7)} vs Always-home ${fmtPct(home7, n7)}`,
    `• Last 30 days (${n30}): Bot ${fmtPct(hits30, n30)} vs Always-home ${fmtPct(home30, n30)}`,
    '',
    `<b>Calibration by top confidence:</b>`,
  ];

  for (const b of buckets) {
    if (b.n > 0) {
      lines.push(`• Said ${b.label}: right ${fmtPct(b.hits, b.n)} (${b.hits}/${b.n})`);
    }
  }

  lines.push('');
  lines.push('<i>Small samples are noisy — short-run hit rates swing widely.</i>');
  lines.push(footer);

  return lines.join('\n');
}
