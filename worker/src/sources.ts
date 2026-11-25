import { getCachedValue, recordApiCall, setCachedValue } from './db';
import { loadTeams, normalizeText, resolveTeam, type TeamRecord } from './teams';
import type { Env } from './types';

export type FetchLike = typeof fetch;

export interface LiveScoreEntry {
  match_id: string;
  home_display: string;
  away_display: string;
  home_goals: number;
  away_goals: number;
  minute: number | null;
  status_short: string;
}

export interface LiveFetchOutcome {
  matches: LiveScoreEntry[];
  source: string;
  from_cache: boolean;
  budget_exhausted: boolean;
  note?: string;
}

export interface FinishedScoreEntry {
  match_id: string;
  home_goals: number;
  away_goals: number;
  source: string;
}

export function seasonFromIso(isoUtc: string): number {
  const d = new Date(isoUtc);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return month < 7 ? year - 1 : year;
}

export function buildMatchId(league: string, season: number, homeCanon: string, awayCanon: string): string {
  return `${league}:${season}:${homeCanon.replace(/\s+/g, '-')}:${awayCanon.replace(/\s+/g, '-')}`;
}

function resolveCanonicalOrNormalized(rawName: string, teams: TeamRecord[]): { canon: string; display: string } {
  const r = resolveTeam(rawName, teams);
  if (r.status === 'resolved') {
    return { canon: r.team.canonical_name, display: r.team.display_name };
  }
  return { canon: normalizeText(rawName), display: rawName };
}

async function fetchLiveFromApiFootball(
  env: Env,
  teams: TeamRecord[],
  league: string,
  season: number,
  fetchFn: FetchLike,
): Promise<LiveScoreEntry[]> {
  const res = await fetchFn('https://v3.football.api-sports.io/fixtures?league=39&live=all', {
    headers: { 'x-apisports-key': env.FOOTBALL_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`API-Football live HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { errors?: unknown; response?: any[] };
  if (payload.errors && (!Array.isArray(payload.errors) || payload.errors.length > 0)) {
    throw new Error(`API-Football error: ${JSON.stringify(payload.errors)}`);
  }
  const out: LiveScoreEntry[] = [];
  for (const item of payload.response ?? []) {
    const h = resolveCanonicalOrNormalized(item.teams.home.name, teams);
    const a = resolveCanonicalOrNormalized(item.teams.away.name, teams);
    out.push({
      match_id: buildMatchId(league, season, h.canon, a.canon),
      home_display: h.display,
      away_display: a.display,
      home_goals: Number(item.goals?.home ?? 0),
      away_goals: Number(item.goals?.away ?? 0),
      minute: item.fixture?.status?.elapsed ?? null,
      status_short: String(item.fixture?.status?.short ?? 'LIVE'),
    });
  }
  return out;
}

async function fetchFplBootstrapAndFixtures(fetchFn: FetchLike): Promise<{
  teamNames: Map<number, string>;
  fixtures: any[];
}> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; FootballPredictor/2.0)',
    Accept: 'application/json',
  };
  const [bRes, fRes] = await Promise.all([
    fetchFn('https://fantasy.premierleague.com/api/bootstrap-static/', { headers }),
    fetchFn('https://fantasy.premierleague.com/api/fixtures/', { headers }),
  ]);
  if (!bRes.ok || !fRes.ok) {
    throw new Error(`FPL HTTP ${bRes.status}/${fRes.status}`);
  }
  const bootstrap = (await bRes.json()) as { teams: Array<{ id: number; name: string }> };
  const fixtures = (await fRes.json()) as any[];
  const teamNames = new Map<number, string>();
  for (const t of bootstrap.teams ?? []) {
    teamNames.set(Number(t.id), t.name);
  }
  return { teamNames, fixtures };
}

async function fetchLiveFromFpl(
  teams: TeamRecord[],
  league: string,
  season: number,
  fetchFn: FetchLike,
): Promise<LiveScoreEntry[]> {
  const { teamNames, fixtures } = await fetchFplBootstrapAndFixtures(fetchFn);
  const out: LiveScoreEntry[] = [];
  for (const fx of fixtures) {
    if (!fx.started || fx.finished || fx.finished_provisional) continue;
    const hRaw = teamNames.get(Number(fx.team_h));
    const aRaw = teamNames.get(Number(fx.team_a));
    if (!hRaw || !aRaw) continue;
    const h = resolveCanonicalOrNormalized(hRaw, teams);
    const a = resolveCanonicalOrNormalized(aRaw, teams);
    out.push({
      match_id: buildMatchId(league, season, h.canon, a.canon),
      home_display: h.display,
      away_display: a.display,
      home_goals: Number(fx.team_h_score ?? 0),
      away_goals: Number(fx.team_a_score ?? 0),
      minute: typeof fx.minutes === 'number' ? fx.minutes : null,
      status_short: 'LIVE',
    });
  }
  return out;
}

export async function fetchLiveMatches(
  env: Env,
  nowIso: string,
  fetchFn: FetchLike = fetch,
): Promise<LiveFetchOutcome> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const cacheKey = `live:${league}`;
  const ttl = Number(env.LIVE_CACHE_SECONDS ?? '60');
  const cap = Number(env.API_DAILY_CAP ?? '80');

  const fresh = await getCachedValue<LiveScoreEntry[]>(env.DB, cacheKey, nowIso, false);
  if (fresh) {
    return {
      matches: fresh.data,
      source: 'cache',
      from_cache: true,
      budget_exhausted: false,
    };
  }

  const teams = await loadTeams(env.DB);
  const season = seasonFromIso(nowIso);
  const budget = await recordApiCall(env.DB, 'api_football', cap, nowIso);

  if (budget.allowed) {
    try {
      const matches = await fetchLiveFromApiFootball(env, teams, league, season, fetchFn);
      await setCachedValue(env.DB, cacheKey, matches, ttl, nowIso);
      for (const m of matches) {
        await env.DB
          .prepare("UPDATE fixtures SET status = 'LIVE', updated_at = ? WHERE match_id = ? AND status = 'NS'")
          .bind(nowIso, m.match_id)
          .run();
      }
      return {
        matches,
        source: 'api_football',
        from_cache: false,
        budget_exhausted: false,
      };
    } catch {
      // Fallback to FPL if API-Football fails transiently
      try {
        const matches = await fetchLiveFromFpl(teams, league, season, fetchFn);
        await setCachedValue(env.DB, cacheKey, matches, ttl, nowIso);
        return {
          matches,
          source: 'fpl_fallback',
          from_cache: false,
          budget_exhausted: false,
          note: 'Live feed served from FPL fallback.',
        };
      } catch {
        const stale = await getCachedValue<LiveScoreEntry[]>(env.DB, cacheKey, nowIso, true);
        if (stale) {
          return {
            matches: stale.data,
            source: 'stale_cache',
            from_cache: true,
            budget_exhausted: false,
            note: `Live provider unavailable; showing cached scores from ${stale.fetched_at.slice(11, 16)} UTC.`,
          };
        }
        return {
          matches: [],
          source: 'unavailable',
          from_cache: false,
          budget_exhausted: false,
          note: 'Live provider temporarily unavailable.',
        };
      }
    }
  }

  // Daily budget exhausted -> serve cached data or zero-quota FPL fallback without failing
  const stale = await getCachedValue<LiveScoreEntry[]>(env.DB, cacheKey, nowIso, true);
  try {
    const matches = await fetchLiveFromFpl(teams, league, season, fetchFn);
    await setCachedValue(env.DB, cacheKey, matches, ttl, nowIso);
    return {
      matches,
      source: 'fpl_budget_fallback',
      from_cache: false,
      budget_exhausted: true,
      note: `Daily API-Football budget (${budget.cap}/${budget.cap}) reached; serving fallback live feed.`,
    };
  } catch {
    return {
      matches: stale?.data ?? [],
      source: stale ? 'stale_cache' : 'budget_exhausted',
      from_cache: Boolean(stale),
      budget_exhausted: true,
      note: stale
        ? `Daily API-Football budget (${budget.cap}/${budget.cap}) reached; showing cached data from ${stale.fetched_at.slice(11, 16)} UTC.`
        : `Daily API-Football budget (${budget.cap}/${budget.cap}) reached and no cached live data is available.`,
    };
  }
}

export async function fetchFinishedScores(
  env: Env,
  dueMatchIds: Set<string>,
  nowIso: string,
  fetchFn: FetchLike = fetch,
): Promise<FinishedScoreEntry[]> {
  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const teams = await loadTeams(env.DB);
  const season = seasonFromIso(nowIso);
  const results = new Map<string, FinishedScoreEntry>();

  // Primary: FPL API (0 API-Football quota)
  try {
    const { teamNames, fixtures } = await fetchFplBootstrapAndFixtures(fetchFn);
    for (const fx of fixtures) {
      if (!(fx.finished || fx.finished_provisional)) continue;
      if (fx.team_h_score === null || fx.team_a_score === null) continue;
      const hRaw = teamNames.get(Number(fx.team_h));
      const aRaw = teamNames.get(Number(fx.team_a));
      if (!hRaw || !aRaw) continue;
      const h = resolveCanonicalOrNormalized(hRaw, teams);
      const a = resolveCanonicalOrNormalized(aRaw, teams);
      const mid = buildMatchId(league, season, h.canon, a.canon);
      if (dueMatchIds.has(mid)) {
        results.set(mid, {
          match_id: mid,
          home_goals: Number(fx.team_h_score),
          away_goals: Number(fx.team_a_score),
          source: 'fpl',
        });
      }
    }
  } catch {
    // Continue to API-Football fallback for missing due matches
  }

  const missing = [...dueMatchIds].filter((id) => !results.has(id));
  if (missing.length > 0) {
    const cap = Number(env.API_DAILY_CAP ?? '80');
    const budget = await recordApiCall(env.DB, 'api_football', cap, nowIso);
    if (budget.allowed) {
      try {
        const dateStr = nowIso.slice(0, 10);
        const res = await fetchFn(
          `https://v3.football.api-sports.io/fixtures?league=39&date=${dateStr}`,
          { headers: { 'x-apisports-key': env.FOOTBALL_API_KEY } },
        );
        if (res.ok) {
          const payload = (await res.json()) as { response?: any[] };
          for (const item of payload.response ?? []) {
            const short = String(item.fixture?.status?.short ?? '');
            if (!['FT', 'AET', 'PEN'].includes(short)) continue;
            const h = resolveCanonicalOrNormalized(item.teams.home.name, teams);
            const a = resolveCanonicalOrNormalized(item.teams.away.name, teams);
            const mid = buildMatchId(league, season, h.canon, a.canon);
            if (dueMatchIds.has(mid) && !results.has(mid)) {
              results.set(mid, {
                match_id: mid,
                home_goals: Number(item.goals?.home ?? 0),
                away_goals: Number(item.goals?.away ?? 0),
                source: 'api_football',
              });
            }
          }
        }
      } catch {
        // Leave missing until next cron pass
      }
    }
  }

  return [...results.values()];
}
