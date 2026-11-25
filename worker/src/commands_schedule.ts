import { getCachedValue } from './db';
import { computeProvisionalEstimate } from './provisional';
import { loadTeams, resolveTeam, splitMatchQuery, type TeamRecord } from './teams';
import { escapeHtml } from './telegram';
import type { Env, Outcome, TeamStrengthSnapshot } from './types';

const WAT_OFFSET_MS = 3600 * 1000;
const DISCLAIMER = '<i>Statistical estimates only, not guarantees. Betting carries risk.</i>';

export function lagosDateStr(isoUtc: string): string {
  const ms = Date.parse(isoUtc) + WAT_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

export function lagosTimeStr(isoUtc: string): string {
  const ms = Date.parse(isoUtc) + WAT_OFFSET_MS;
  return new Date(ms).toISOString().slice(11, 16) + ' WAT';
}

export function lagosDateTimeLabel(isoUtc: string): string {
  const ms = Date.parse(isoUtc) + WAT_OFFSET_MS;
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayName = days[d.getUTCDay()];
  const dayNum = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()];
  const hhmm = d.toISOString().slice(11, 16);
  return `${dayName} ${dayNum} ${mon}, ${hhmm} WAT`;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function outcomeLabel(o: Outcome, home: string, away: string): string {
  if (o === 'H') return `${home} win`;
  if (o === 'A') return `${away} win`;
  return 'Draw';
}

function isCloseMatch(pHome: number, pDraw: number, pAway: number, gapThreshold: number): boolean {
  const sorted = [pHome, pDraw, pAway].sort((a, b) => b - a);
  return sorted[0] - sorted[1] <= gapThreshold;
}

interface FixtureWithPredAndResult {
  match_id: string;
  home_team: string;
  away_team: string;
  home_display: string;
  away_display: string;
  kickoff_utc: string;
  status: string;
  p_home: number | null;
  p_draw: number | null;
  p_away: number | null;
  xg_home: number | null;
  xg_away: number | null;
  predicted_outcome: Outcome | null;
  summary_reason: string | null;
  home_goals: number | null;
  away_goals: number | null;
}

async function queryFixturesWithPreds(
  db: D1Database,
  league: string,
): Promise<FixtureWithPredAndResult[]> {
  const { results } = await db
    .prepare(
      `SELECT f.match_id, f.home_team, f.away_team, f.home_display, f.away_display,
              f.kickoff_utc, f.status,
              p.p_home, p.p_draw, p.p_away, p.xg_home, p.xg_away,
              p.predicted_outcome, p.summary_reason,
              r.home_goals, r.away_goals
       FROM fixtures f
       LEFT JOIN predictions p
         ON p.id = (
           SELECT id FROM predictions p2
           WHERE p2.match_id = f.match_id
           ORDER BY p2.id DESC LIMIT 1
         )
       LEFT JOIN results r ON r.match_id = f.match_id
       WHERE f.league = ?
       ORDER BY f.kickoff_utc ASC`,
    )
    .bind(league)
    .all<FixtureWithPredAndResult>();
  return results;
}

function formatDayMatch(m: FixtureWithPredAndResult, closeGap: number, nowMs: number): string {
  const home = escapeHtml(m.home_display);
  const away = escapeHtml(m.away_display);
  let statusLine = lagosTimeStr(m.kickoff_utc);
  if (m.status === 'FT' && m.home_goals !== null && m.away_goals !== null) {
    statusLine = `FT ${m.home_goals}-${m.away_goals}`;
  } else if (m.status === 'LIVE' && m.home_goals !== null && m.away_goals !== null) {
    statusLine = `LIVE ${m.home_goals}-${m.away_goals}`;
  } else if (m.status === 'PST') {
    statusLine = 'Postponed';
  }

  const lines = [`<b>${home} vs ${away}</b> (${statusLine})`];
  if (m.p_home !== null && m.p_draw !== null && m.p_away !== null && m.predicted_outcome) {
    const pick = escapeHtml(outcomeLabel(m.predicted_outcome, m.home_display, m.away_display));
    lines.push(
      `Pick: <b>${pick}</b> — H ${pct(m.p_home)} | D ${pct(m.p_draw)} | A ${pct(m.p_away)}`,
    );
    if (isCloseMatch(m.p_home, m.p_draw, m.p_away, closeGap)) {
      lines.push('⚖️ Close match, draw risk');
    }
  } else if (m.status === 'NS') {
    const hoursAway = (Date.parse(m.kickoff_utc) - nowMs) / 3600_000;
    if (hoursAway > 36) {
      lines.push('Prediction locks within 36h of kickoff (use /match for provisional view).');
    } else {
      lines.push('Predictions not ready yet — check back after the daily update.');
    }
  }
  return lines.join('\n');
}

export async function handleDayCommand(
  env: Env,
  dayOffset: 0 | 1,
  nowIso: string,
): Promise<string> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const closeGap = Number(env.CLOSE_MATCH_GAP ?? '0.08');
  const nowMs = Date.parse(nowIso);
  const targetIso = new Date(nowMs + dayOffset * 24 * 3600_000).toISOString();
  const targetDate = lagosDateStr(targetIso);
  const label = dayOffset === 0 ? "Today's" : "Tomorrow's";

  const all = await queryFixturesWithPreds(env.DB, league);
  const dayMatches = all.filter((m) => lagosDateStr(m.kickoff_utc) === targetDate);

  if (!dayMatches.length) {
    const nextUpcoming = all.find((m) => m.status === 'NS' && Date.parse(m.kickoff_utc) > nowMs);
    const nextHint = nextUpcoming
      ? `\n\nNext fixture: <b>${escapeHtml(nextUpcoming.home_display)} vs ${escapeHtml(nextUpcoming.away_display)}</b> (${lagosDateTimeLabel(nextUpcoming.kickoff_utc)})`
      : '';
    return `<b>${label} Premier League Matches (${targetDate} WAT)</b>\nNo Premier League matches scheduled.${nextHint}`;
  }

  const blocks = dayMatches.map((m) => formatDayMatch(m, closeGap, nowMs));
  return [`<b>${label} Premier League Matches (${targetDate} WAT)</b>`, '', ...blocks.join('\n\n').split('\n')].join('\n');
}

async function getTeamRecentForm(db: D1Database, teamCanon: string, limit = 5): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT f.home_team, f.away_team, f.home_display, f.away_display,
              r.home_goals, r.away_goals, f.kickoff_utc
       FROM fixtures f
       JOIN results r ON r.match_id = f.match_id
       WHERE f.home_team = ? OR f.away_team = ?
       ORDER BY f.kickoff_utc DESC
       LIMIT ?`,
    )
    .bind(teamCanon, teamCanon, limit)
    .all<{
      home_team: string;
      away_team: string;
      home_display: string;
      away_display: string;
      home_goals: number;
      away_goals: number;
    }>();

  if (!results.length) return 'No recent settled matches';
  return results
    .map((r) => {
      const isHome = r.home_team === teamCanon;
      const gf = isHome ? r.home_goals : r.away_goals;
      const ga = isHome ? r.away_goals : r.home_goals;
      const badge = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
      const opp = isHome ? r.away_display : r.home_display;
      return `${badge} ${gf}-${ga} vs ${escapeHtml(opp)}`;
    })
    .join(', ');
}

async function getHeadToHead(
  db: D1Database,
  teamA: string,
  teamB: string,
  limit = 5,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT f.home_display, f.away_display, r.home_goals, r.away_goals, f.kickoff_utc
       FROM fixtures f
       JOIN results r ON r.match_id = f.match_id
       WHERE (f.home_team = ? AND f.away_team = ?)
          OR (f.home_team = ? AND f.away_team = ?)
       ORDER BY f.kickoff_utc DESC
       LIMIT ?`,
    )
    .bind(teamA, teamB, teamB, teamA, limit)
    .all<{
      home_display: string;
      away_display: string;
      home_goals: number;
      away_goals: number;
      kickoff_utc: string;
    }>();

  if (!results.length) return ['No recent head-to-head in database'];
  return results.map(
    (r) =>
      `${r.kickoff_utc.slice(0, 10)}: ${escapeHtml(r.home_display)} ${r.home_goals}-${r.away_goals} ${escapeHtml(r.away_display)}`,
  );
}

function formatResolutionError(query: string, res: { status: 'ambiguous'; candidates: TeamRecord[] } | { status: 'unknown' }): string {
  if (res.status === 'ambiguous') {
    const names = res.candidates.map((c) => escapeHtml(c.display_name)).join(', ');
    return `Multiple teams match "<b>${escapeHtml(query)}</b>": ${names}.\nPlease be more specific.`;
  }
  return `Could not recognize Premier League team "<b>${escapeHtml(query)}</b>".\nTry e.g. <code>/match Arsenal</code> or <code>/match Man U vs Spurs</code>.`;
}

export async function handleMatchCommand(
  env: Env,
  rawQuery: string,
  nowIso: string,
): Promise<string> {
  if (!rawQuery.trim()) {
    return 'Usage: <code>/match Arsenal</code> or <code>/match Man U vs Chelsea</code>';
  }
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const closeGap = Number(env.CLOSE_MATCH_GAP ?? '0.08');
  const nowMs = Date.parse(nowIso);

  const teams = await loadTeams(env.DB);
  const { homeQuery, awayQuery } = splitMatchQuery(rawQuery);

  const r1 = resolveTeam(homeQuery, teams);
  if (r1.status !== 'resolved') {
    return formatResolutionError(homeQuery, r1);
  }

  let r2Team: TeamRecord | null = null;
  if (awayQuery !== null) {
    const r2 = resolveTeam(awayQuery, teams);
    if (r2.status !== 'resolved') {
      return formatResolutionError(awayQuery, r2);
    }
    r2Team = r2.team;
  }

  const all = await queryFixturesWithPreds(env.DB, league);
  let target: FixtureWithPredAndResult | undefined;

  if (r2Team) {
    const matching = all.filter(
      (m) =>
        (m.home_team === r1.team.canonical_name && m.away_team === r2Team!.canonical_name) ||
        (m.home_team === r2Team!.canonical_name && m.away_team === r1.team.canonical_name),
    );
    target =
      matching.find((m) => m.status !== 'FT' && Date.parse(m.kickoff_utc) >= nowMs - 3 * 3600_000) ??
      matching[matching.length - 1];
  } else {
    const matching = all.filter(
      (m) => m.home_team === r1.team.canonical_name || m.away_team === r1.team.canonical_name,
    );
    target =
      matching.find((m) => m.status !== 'FT' && Date.parse(m.kickoff_utc) >= nowMs - 3 * 3600_000) ??
      matching[matching.length - 1];
  }

  if (!target) {
    const pairLabel = r2Team
      ? `${escapeHtml(r1.team.display_name)} vs ${escapeHtml(r2Team.display_name)}`
      : escapeHtml(r1.team.display_name);
    return `No upcoming or recent fixture found in the schedule window for <b>${pairLabel}</b>.`;
  }

  const homeName = escapeHtml(target.home_display);
  const awayName = escapeHtml(target.away_display);
  const lines: string[] = [
    `<b>${homeName} vs ${awayName}</b>`,
    `Kickoff: ${lagosDateTimeLabel(target.kickoff_utc)}`,
  ];

  if (target.status === 'FT' && target.home_goals !== null && target.away_goals !== null) {
    lines.push(`Final score: <b>${target.home_goals} - ${target.away_goals}</b>`);
  }

  if (
    target.p_home !== null &&
    target.p_draw !== null &&
    target.p_away !== null &&
    target.predicted_outcome
  ) {
    lines.push('');
    lines.push(
      `<b>Locked prediction:</b> ${escapeHtml(outcomeLabel(target.predicted_outcome, target.home_display, target.away_display))}`,
    );
    lines.push(
      `Home ${pct(target.p_home)} | Draw ${pct(target.p_draw)} | Away ${pct(target.p_away)}`,
    );
    if (isCloseMatch(target.p_home, target.p_draw, target.p_away, closeGap)) {
      lines.push('⚖️ Close match, draw risk');
    }
    if (target.xg_home !== null && target.xg_away !== null) {
      lines.push(`Expected goals: ${target.xg_home.toFixed(2)} – ${target.xg_away.toFixed(2)}`);
    }
    if (target.summary_reason) {
      lines.push(`Why: ${escapeHtml(target.summary_reason)}`);
    }
  } else {
    const hoursAway = (Date.parse(target.kickoff_utc) - nowMs) / 3600_000;
    const strengths = await getCachedValue<TeamStrengthSnapshot>(
      env.DB,
      `team_strengths:${league}`,
      nowIso,
      true,
    );
    lines.push('');
    if (hoursAway > 36) {
      lines.push('<i>Locked prediction will appear once kickoff is within 36 hours.</i>');
      if (strengths) {
        const prov = computeProvisionalEstimate(
          strengths.data,
          target.home_team,
          target.away_team,
        );
        lines.push(
          `<b>[PROVISIONAL — indicative only, not stored]</b> ${escapeHtml(outcomeLabel(prov.predicted_outcome, target.home_display, target.away_display))}`,
        );
        lines.push(
          `Home ${pct(prov.p_home)} | Draw ${pct(prov.p_draw)} | Away ${pct(prov.p_away)}`,
        );
        if (isCloseMatch(prov.p_home, prov.p_draw, prov.p_away, closeGap)) {
          lines.push('⚖️ Close match, draw risk');
        }
        lines.push(`Expected goals: ${prov.xg_home.toFixed(2)} – ${prov.xg_away.toFixed(2)}`);
        lines.push(`Why: ${escapeHtml(prov.summary_reason)}`);
      }
    } else {
      lines.push('Predictions not ready yet — check back after the daily update.');
    }
  }

  const [homeForm, awayForm, h2h] = await Promise.all([
    getTeamRecentForm(env.DB, target.home_team, 5),
    getTeamRecentForm(env.DB, target.away_team, 5),
    getHeadToHead(env.DB, target.home_team, target.away_team, 5),
  ]);

  lines.push('');
  lines.push(`<b>Recent form (last 5):</b>`);
  lines.push(`• ${homeName}: ${homeForm}`);
  lines.push(`• ${awayName}: ${awayForm}`);
  lines.push('');
  lines.push(`<b>Head-to-head (last 5):</b>`);
  for (const row of h2h) {
    lines.push(`• ${row}`);
  }
  lines.push('');
  lines.push(DISCLAIMER);

  return lines.join('\n');
}
