import { getCachedValue } from './db';
import { computeProvisionalEstimate } from './provisional';
import {
  getCurrentPremierLeagueTeams,
  loadTeams,
  resolveTeam,
  splitMatchQuery,
  type TeamRecord,
} from './teams';
import { escapeHtml } from './telegram';
import type {
  Env,
  InlineKeyboardButton,
  Outcome,
  RenderedScreen,
  TeamStrengthSnapshot,
} from './types';

const WAT_OFFSET_MS = 3600 * 1000;
const PAGE_SIZE = 8;
const DISCLAIMER = '<i>Statistical estimates only, not guarantees. Betting carries risk.</i>';

export function lagosDateStr(isoUtc: string): string {
  const ms = Date.parse(isoUtc) + WAT_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

export function lagosTimeRaw(isoUtc: string): string {
  const ms = Date.parse(isoUtc) + WAT_OFFSET_MS;
  return new Date(ms).toISOString().slice(11, 16);
}

export function lagosTimeStr(isoUtc: string): string {
  return `${lagosTimeRaw(isoUtc)} WAT`;
}

export function addDaysDateStr(dateStr: string, deltaDays: number): string {
  const baseMs = Date.parse(`${dateStr}T12:00:00Z`);
  return new Date(baseMs + deltaDays * 24 * 3600_000).toISOString().slice(0, 10);
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

export interface FixtureWithPredAndResult {
  row_id: number;
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
      `SELECT f.rowid AS row_id, f.match_id, f.home_team, f.away_team, f.home_display, f.away_display,
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
  } else if (m.status === 'LIVE') {
    statusLine = 'LIVE';
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
      lines.push('Prediction locks within 36h of kickoff (tap match for provisional view).');
    } else {
      lines.push('Predictions not ready yet — check back after the daily update.');
    }
  }
  return lines.join('\n');
}

function matchButtonLabel(m: FixtureWithPredAndResult): string {
  if (m.status === 'FT' && m.home_goals !== null && m.away_goals !== null) {
    return `FT ${m.home_goals}-${m.away_goals} ${m.home_display} v ${m.away_display}`;
  }
  if (m.status === 'LIVE') {
    const score = m.home_goals !== null && m.away_goals !== null ? `${m.home_goals}-${m.away_goals} ` : '';
    return `LIVE ${score}${m.home_display} v ${m.away_display}`;
  }
  if (m.status === 'PST') {
    return `PST ${m.home_display} v ${m.away_display}`;
  }
  return `${lagosTimeRaw(m.kickoff_utc)} ${m.home_display} v ${m.away_display}`;
}

export async function buildDayView(
  env: Env,
  targetDate: string,
  page: number,
  nowIso: string,
): Promise<RenderedScreen> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const closeGap = Number(env.CLOSE_MATCH_GAP ?? '0.08');
  const nowMs = Date.parse(nowIso);
  const todayDate = lagosDateStr(nowIso);
  const tomorrowDate = addDaysDateStr(todayDate, 1);

  const label =
    targetDate === todayDate
      ? "Today's Premier League Matches"
      : targetDate === tomorrowDate
        ? "Tomorrow's Premier League Matches"
        : 'Premier League Matches';

  const all = await queryFixturesWithPreds(env.DB, league);
  const dayMatches = all.filter((m) => lagosDateStr(m.kickoff_utc) === targetDate);
  const prevDate = addDaysDateStr(targetDate, -1);
  const nextDate = addDaysDateStr(targetDate, 1);

  const inline_keyboard: InlineKeyboardButton[][] = [];

  if (!dayMatches.length) {
    const targetEndMs = Date.parse(`${targetDate}T23:59:59Z`);
    const nextUpcoming = all.find(
      (m) => m.status === 'NS' && Date.parse(m.kickoff_utc) > Math.max(nowMs, targetEndMs),
    ) ?? all.find((m) => m.status === 'NS' && Date.parse(m.kickoff_utc) > nowMs);

    const nextHint = nextUpcoming
      ? `\n\nNext fixture: <b>${escapeHtml(nextUpcoming.home_display)} vs ${escapeHtml(nextUpcoming.away_display)}</b> (${lagosDateTimeLabel(nextUpcoming.kickoff_utc)})`
      : '';

    if (nextUpcoming) {
      inline_keyboard.push([
        {
          text: `👉 ${matchButtonLabel(nextUpcoming)}`,
          callback_data: `v1:md:${nextUpcoming.row_id}:${targetDate}:0`,
        },
      ]);
    }
    inline_keyboard.push([
      { text: '⬅️ Prev day', callback_data: `v1:day:${prevDate}:0` },
      { text: 'Next day ➡️', callback_data: `v1:day:${nextDate}:0` },
    ]);
    inline_keyboard.push([
      { text: '⬅️ Back', callback_data: 'v1:home' },
      { text: '🏠 Home', callback_data: 'v1:home' },
    ]);

    return {
      text: `<b>${label} (${targetDate} WAT)</b>\nNo Premier League matches scheduled.${nextHint}`,
      inline_keyboard,
    };
  }

  const totalPages = Math.max(1, Math.ceil(dayMatches.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PAGE_SIZE;
  const slice = dayMatches.slice(start, start + PAGE_SIZE);

  for (const m of slice) {
    inline_keyboard.push([
      {
        text: matchButtonLabel(m),
        callback_data: `v1:md:${m.row_id}:${targetDate}:${safePage}`,
      },
    ]);
  }

  if (totalPages > 1) {
    const pageRow: InlineKeyboardButton[] = [];
    if (safePage > 0) {
      pageRow.push({ text: '⬅️ Previous', callback_data: `v1:day:${targetDate}:${safePage - 1}` });
    }
    if (safePage < totalPages - 1) {
      pageRow.push({ text: 'Next ➡️', callback_data: `v1:day:${targetDate}:${safePage + 1}` });
    }
    if (pageRow.length) inline_keyboard.push(pageRow);
  }

  inline_keyboard.push([
    { text: '⬅️ Prev day', callback_data: `v1:day:${prevDate}:0` },
    { text: 'Next day ➡️', callback_data: `v1:day:${nextDate}:0` },
  ]);
  inline_keyboard.push([
    { text: '🔄 Refresh', callback_data: `v1:day:${targetDate}:${safePage}` },
    { text: '⬅️ Back', callback_data: 'v1:home' },
    { text: '🏠 Home', callback_data: 'v1:home' },
  ]);

  const pageNote = totalPages > 1 ? ` — Page ${safePage + 1}/${totalPages}` : '';
  const blocks = slice.map((m) => formatDayMatch(m, closeGap, nowMs));
  return {
    text: [`<b>${label} (${targetDate} WAT)${pageNote}</b>`, '', ...blocks.join('\n\n').split('\n')].join('\n'),
    inline_keyboard,
  };
}

export async function handleDayCommand(
  env: Env,
  dayOffset: 0 | 1,
  nowIso: string,
): Promise<string> {
  const targetIso = new Date(Date.parse(nowIso) + dayOffset * 24 * 3600_000).toISOString();
  const targetDate = lagosDateStr(targetIso);
  const view = await buildDayView(env, targetDate, 0, nowIso);
  return view.text;
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

function formatResolutionError(
  query: string,
  res: { status: 'ambiguous'; candidates: TeamRecord[] } | { status: 'unknown' },
): string {
  if (res.status === 'ambiguous') {
    const names = res.candidates.map((c) => escapeHtml(c.display_name)).join(', ');
    return `Multiple teams match "<b>${escapeHtml(query)}</b>": ${names}.\nPlease be more specific.`;
  }
  return `Could not recognize Premier League team "<b>${escapeHtml(query)}</b>".\nTry e.g. <code>/match Arsenal</code> or <code>/match Man U vs Spurs</code>.`;
}

async function formatPredictionBlock(
  env: Env,
  target: FixtureWithPredAndResult,
  nowIso: string,
  league: string,
  closeGap: number,
  nowMs: number,
): Promise<string[]> {
  const lines: string[] = [];
  if (
    target.p_home !== null &&
    target.p_draw !== null &&
    target.p_away !== null &&
    target.predicted_outcome
  ) {
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
    return lines;
  }

  const hoursAway = (Date.parse(target.kickoff_utc) - nowMs) / 3600_000;
  const strengths = await getCachedValue<TeamStrengthSnapshot>(
    env.DB,
    `team_strengths:${league}`,
    nowIso,
    true,
  );
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
  return lines;
}

export async function formatMatchDetailText(
  env: Env,
  target: FixtureWithPredAndResult,
  nowIso: string,
): Promise<string> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const closeGap = Number(env.CLOSE_MATCH_GAP ?? '0.08');
  const nowMs = Date.parse(nowIso);
  const homeName = escapeHtml(target.home_display);
  const awayName = escapeHtml(target.away_display);
  const lines: string[] = [
    `<b>${homeName} vs ${awayName}</b>`,
    `Kickoff: ${lagosDateTimeLabel(target.kickoff_utc)}`,
  ];

  if (target.status === 'FT' && target.home_goals !== null && target.away_goals !== null) {
    lines.push(`Final score: <b>${target.home_goals} - ${target.away_goals}</b> (FT)`);
  } else if (target.status === 'LIVE') {
    const score =
      target.home_goals !== null && target.away_goals !== null
        ? ` <b>${target.home_goals} - ${target.away_goals}</b>`
        : '';
    lines.push(`Status: <b>LIVE</b>${score}`);
  } else if (target.status === 'PST') {
    lines.push('Status: <b>Postponed</b>');
  }

  lines.push('');
  lines.push(...(await formatPredictionBlock(env, target, nowIso, league, closeGap, nowMs)));

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

export async function buildMatchDetailView(
  env: Env,
  rowId: number,
  backCallback: string,
  refreshCallback: string,
  nowIso: string,
): Promise<RenderedScreen> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const target = await env.DB
    .prepare(
      `SELECT f.rowid AS row_id, f.match_id, f.home_team, f.away_team, f.home_display, f.away_display,
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
       WHERE f.rowid = ? AND f.league = ?`,
    )
    .bind(rowId, league)
    .first<FixtureWithPredAndResult>();

  if (!target) {
    return {
      text: 'Match not found in the current schedule.',
      inline_keyboard: [
        [
          { text: '⬅️ Back to list', callback_data: backCallback },
          { text: '🏠 Home', callback_data: 'v1:home' },
        ],
      ],
    };
  }

  return {
    text: await formatMatchDetailText(env, target, nowIso),
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: refreshCallback }],
      [
        { text: '⬅️ Back to list', callback_data: backCallback },
        { text: '🏠 Home', callback_data: 'v1:home' },
      ],
    ],
  };
}

export function buildTeamsGridView(): RenderedScreen {
  const teams = getCurrentPremierLeagueTeams();
  const inline_keyboard: InlineKeyboardButton[][] = [];
  for (let i = 0; i < teams.length; i += 3) {
    const row = teams.slice(i, i + 3).map((t) => {
      const code = t.short_name ?? t.display_name;
      return {
        text: code,
        callback_data: `v1:t:${code}`,
      };
    });
    inline_keyboard.push(row);
  }
  inline_keyboard.push([
    { text: '⬅️ Back', callback_data: 'v1:home' },
    { text: '🏠 Home', callback_data: 'v1:home' },
  ]);

  const legend = teams
    .map((t) => `<code>${escapeHtml(t.short_name ?? '')}</code> ${escapeHtml(t.display_name)}`)
    .join(' · ');

  return {
    text: [
      '<b>Find a Premier League Match</b>',
      'Tap a team below to see its next fixture and last 5 results (or type a team name like <code>Arsenal</code>).',
      '',
      legend,
    ].join('\n'),
    inline_keyboard,
  };
}

export async function buildTeamView(
  env: Env,
  teamCodeOrName: string,
  nowIso: string,
): Promise<RenderedScreen> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const closeGap = Number(env.CLOSE_MATCH_GAP ?? '0.08');
  const nowMs = Date.parse(nowIso);
  const teams = await loadTeams(env.DB);
  const res = resolveTeam(teamCodeOrName, teams);

  if (res.status !== 'resolved') {
    return {
      text: formatResolutionError(teamCodeOrName, res),
      inline_keyboard: [
        [
          { text: '⬅️ Back', callback_data: 'v1:teams' },
          { text: '🏠 Home', callback_data: 'v1:home' },
        ],
      ],
    };
  }

  const team = res.team;
  const code = team.short_name ?? team.canonical_name;
  const all = await queryFixturesWithPreds(env.DB, league);
  const upcoming = all.find(
    (m) =>
      (m.home_team === team.canonical_name || m.away_team === team.canonical_name) &&
      m.status !== 'FT' &&
      Date.parse(m.kickoff_utc) >= nowMs - 3 * 3600_000,
  );
  const recentForm = await getTeamRecentForm(env.DB, team.canonical_name, 5);

  const lines: string[] = [`<b>${escapeHtml(team.display_name)}</b>`];

  if (upcoming) {
    lines.push(
      `Next fixture: <b>${escapeHtml(upcoming.home_display)} vs ${escapeHtml(upcoming.away_display)}</b>`,
    );
    lines.push(`Kickoff: ${lagosDateTimeLabel(upcoming.kickoff_utc)}`);
    if (upcoming.status === 'LIVE') {
      const score =
        upcoming.home_goals !== null && upcoming.away_goals !== null
          ? ` <b>${upcoming.home_goals} - ${upcoming.away_goals}</b>`
          : '';
      lines.push(`Status: <b>LIVE</b>${score}`);
    } else if (upcoming.status === 'PST') {
      lines.push('Status: <b>Postponed</b>');
    }
    lines.push('');
    lines.push(...(await formatPredictionBlock(env, upcoming, nowIso, league, closeGap, nowMs)));
  } else {
    lines.push('No upcoming Premier League fixture scheduled.');
  }

  lines.push('');
  lines.push(`<b>Last 5 results:</b>`);
  lines.push(recentForm);
  lines.push('');
  lines.push(DISCLAIMER);

  const inline_keyboard: InlineKeyboardButton[][] = [];
  if (upcoming) {
    inline_keyboard.push([
      { text: '🔍 Full match & H2H', callback_data: `v1:mt:${upcoming.row_id}:${code}` },
      { text: '🔄 Refresh', callback_data: `v1:t:${code}` },
    ]);
  } else {
    inline_keyboard.push([{ text: '🔄 Refresh', callback_data: `v1:t:${code}` }]);
  }
  inline_keyboard.push([
    { text: '⬅️ Back', callback_data: 'v1:teams' },
    { text: '🏠 Home', callback_data: 'v1:home' },
  ]);

  return { text: lines.join('\n'), inline_keyboard };
}

export async function handleMatchCommand(
  env: Env,
  rawQuery: string,
  nowIso: string,
): Promise<string> {
  const screen = await buildMatchQueryView(env, rawQuery, nowIso);
  return screen.text;
}

export async function buildMatchQueryView(
  env: Env,
  rawQuery: string,
  nowIso: string,
): Promise<RenderedScreen> {
  if (!rawQuery.trim()) {
    return buildTeamsGridView();
  }
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const nowMs = Date.parse(nowIso);
  const teams = await loadTeams(env.DB);
  const { homeQuery, awayQuery } = splitMatchQuery(rawQuery);
  const r1 = resolveTeam(homeQuery, teams);
  if (r1.status !== 'resolved') {
    return {
      text: formatResolutionError(homeQuery, r1),
      inline_keyboard: [
        [
          { text: '🔍 Team list', callback_data: 'v1:teams' },
          { text: '🏠 Home', callback_data: 'v1:home' },
        ],
      ],
    };
  }
  let r2Team: TeamRecord | null = null;
  if (awayQuery !== null) {
    const r2 = resolveTeam(awayQuery, teams);
    if (r2.status !== 'resolved') {
      return {
        text: formatResolutionError(awayQuery, r2),
        inline_keyboard: [
          [
            { text: '🔍 Team list', callback_data: 'v1:teams' },
            { text: '🏠 Home', callback_data: 'v1:home' },
          ],
        ],
      };
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
    return {
      text: `No upcoming or recent fixture found in the schedule window for <b>${pairLabel}</b>.`,
      inline_keyboard: [
        [
          { text: '🔍 Team list', callback_data: 'v1:teams' },
          { text: '🏠 Home', callback_data: 'v1:home' },
        ],
      ],
    };
  }

  const dateStr = lagosDateStr(target.kickoff_utc);
  return {
    text: await formatMatchDetailText(env, target, nowIso),
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: `v1:md:${target.row_id}:${dateStr}:0` }],
      [
        { text: '⬅️ Back', callback_data: 'v1:teams' },
        { text: '🏠 Home', callback_data: 'v1:home' },
      ],
    ],
  };
}
