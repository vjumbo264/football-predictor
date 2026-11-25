import { lagosDateStr } from './commands_schedule';
import { fetchLiveMatches, type FetchLike } from './sources';
import { escapeHtml } from './telegram';
import type { Env, Outcome } from './types';

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function outcomeShort(o: Outcome, home: string, away: string): string {
  if (o === 'H') return `${home} win`;
  if (o === 'A') return `${away} win`;
  return 'Draw';
}

export async function handleLiveCommand(
  env: Env,
  nowIso: string,
  fetchFn: FetchLike = fetch,
): Promise<string> {
  const outcome = await fetchLiveMatches(env, nowIso, fetchFn);
  const lines: string[] = ['<b>Live Premier League Matches</b>'];

  if (outcome.note) {
    lines.push(`<i>${escapeHtml(outcome.note)}</i>`);
  }

  if (!outcome.matches.length) {
    lines.push('');
    lines.push('No Premier League matches are in play right now.');
    return lines.join('\n');
  }

  for (const m of outcome.matches) {
    const pred = await env.DB
      .prepare(
        `SELECT p_home, p_draw, p_away, predicted_outcome
         FROM predictions WHERE match_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(m.match_id)
      .first<{ p_home: number; p_draw: number; p_away: number; predicted_outcome: Outcome }>();

    const minText = m.minute !== null ? `${m.minute}'` : m.status_short;
    lines.push('');
    lines.push(
      `<b>${escapeHtml(m.home_display)} ${m.home_goals} - ${m.away_goals} ${escapeHtml(m.away_display)}</b> (${escapeHtml(minText)})`,
    );
    if (pred) {
      const pick = escapeHtml(outcomeShort(pred.predicted_outcome, m.home_display, m.away_display));
      lines.push(
        `Locked pick: <b>${pick}</b> — H ${pct(pred.p_home)} | D ${pct(pred.p_draw)} | A ${pct(pred.p_away)}`,
      );
    } else {
      lines.push('No locked pre-match prediction recorded.');
    }
  }

  return lines.join('\n');
}

export async function handleResultsCommand(env: Env, _nowIso: string): Promise<string> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const { results } = await env.DB
    .prepare(
      `SELECT f.match_id, f.home_display, f.away_display, f.kickoff_utc,
              r.home_goals, r.away_goals, r.actual_outcome,
              p.p_home, p.p_draw, p.p_away, p.predicted_outcome,
              pr.is_correct
       FROM results r
       JOIN fixtures f ON f.match_id = r.match_id
       LEFT JOIN predictions p ON p.id = (
         SELECT id FROM predictions p2 WHERE p2.match_id = f.match_id ORDER BY p2.id DESC LIMIT 1
       )
       LEFT JOIN prediction_results pr ON pr.prediction_id = p.id
       WHERE f.league = ?
       ORDER BY f.kickoff_utc DESC
       LIMIT 10`,
    )
    .bind(league)
    .all<{
      match_id: string;
      home_display: string;
      away_display: string;
      kickoff_utc: string;
      home_goals: number;
      away_goals: number;
      actual_outcome: Outcome;
      p_home: number | null;
      p_draw: number | null;
      p_away: number | null;
      predicted_outcome: Outcome | null;
      is_correct: number | null;
    }>();

  if (!results.length) {
    return '<b>Recent Premier League Results</b>\nNo finished matches recorded yet.';
  }

  const lines: string[] = ['<b>Recent Premier League Results</b>'];
  for (const r of results) {
    const dateWat = lagosDateStr(r.kickoff_utc);
    lines.push('');
    lines.push(
      `<b>${escapeHtml(r.home_display)} ${r.home_goals} - ${r.away_goals} ${escapeHtml(r.away_display)}</b> (${dateWat})`,
    );
    if (r.predicted_outcome && r.p_home !== null && r.p_draw !== null && r.p_away !== null) {
      const hit =
        r.is_correct !== null
          ? r.is_correct === 1
          : r.predicted_outcome === r.actual_outcome;
      const badge = hit ? '✅ Hit' : '❌ Miss';
      const pick = escapeHtml(outcomeShort(r.predicted_outcome, r.home_display, r.away_display));
      lines.push(
        `Pick: ${pick} (H ${pct(r.p_home)} | D ${pct(r.p_draw)} | A ${pct(r.p_away)}) — <b>${badge}</b>`,
      );
    } else {
      lines.push('No pre-match prediction recorded.');
    }
  }

  return lines.join('\n');
}
