export interface TeamRecord {
  canonical_name: string;
  display_name: string;
  short_name: string | null;
  aliases: string[];
}

export type TeamResolution =
  | { status: 'resolved'; team: TeamRecord }
  | { status: 'ambiguous'; candidates: TeamRecord[] }
  | { status: 'unknown'; query: string };

const BUILTIN_TEAMS: TeamRecord[] = [
  { canonical_name: 'arsenal', display_name: 'Arsenal', short_name: 'ARS', aliases: ['arsenal', 'ars', 'gunners'] },
  { canonical_name: 'aston villa', display_name: 'Aston Villa', short_name: 'AVL', aliases: ['aston villa', 'villa', 'avl'] },
  { canonical_name: 'bournemouth', display_name: 'Bournemouth', short_name: 'BOU', aliases: ['bournemouth', 'bou', 'cherries'] },
  { canonical_name: 'brentford', display_name: 'Brentford', short_name: 'BRE', aliases: ['brentford', 'bre', 'bees'] },
  { canonical_name: 'brighton', display_name: 'Brighton', short_name: 'BHA', aliases: ['brighton', 'bha', 'seagulls', 'brighton and hove albion'] },
  { canonical_name: 'chelsea', display_name: 'Chelsea', short_name: 'CHE', aliases: ['chelsea', 'che', 'blues'] },
  { canonical_name: 'coventry', display_name: 'Coventry', short_name: 'COV', aliases: ['coventry', 'coventry city', 'cov'] },
  { canonical_name: 'crystal palace', display_name: 'Crystal Palace', short_name: 'CRY', aliases: ['crystal palace', 'palace', 'cry', 'eagles'] },
  { canonical_name: 'everton', display_name: 'Everton', short_name: 'EVE', aliases: ['everton', 'eve', 'toffees'] },
  { canonical_name: 'fulham', display_name: 'Fulham', short_name: 'FUL', aliases: ['fulham', 'ful', 'cottagers'] },
  { canonical_name: 'hull', display_name: 'Hull', short_name: 'HUL', aliases: ['hull', 'hull city', 'hul', 'tigers'] },
  { canonical_name: 'ipswich', display_name: 'Ipswich', short_name: 'IPS', aliases: ['ipswich', 'ipswich town', 'ips'] },
  { canonical_name: 'leeds', display_name: 'Leeds', short_name: 'LEE', aliases: ['leeds', 'leeds united', 'lee'] },
  { canonical_name: 'liverpool', display_name: 'Liverpool', short_name: 'LIV', aliases: ['liverpool', 'liv', 'lfc'] },
  { canonical_name: 'manchester city', display_name: 'Man City', short_name: 'MCI', aliases: ['man city', 'manchester city', 'mci', 'mcfc', 'city'] },
  { canonical_name: 'manchester united', display_name: 'Man Utd', short_name: 'MUN', aliases: ['man u', 'man utd', 'man united', 'manchester united', 'mun', 'mufc'] },
  { canonical_name: 'newcastle', display_name: 'Newcastle', short_name: 'NEW', aliases: ['newcastle', 'newcastle united', 'new', 'nufc', 'toon'] },
  { canonical_name: 'nott m forest', display_name: "Nott'm Forest", short_name: 'NFO', aliases: ['nottingham forest', 'nottm forest', 'nott m forest', 'forest', 'nfo'] },
  { canonical_name: 'sunderland', display_name: 'Sunderland', short_name: 'SUN', aliases: ['sunderland', 'sun', 'black cats'] },
  { canonical_name: 'tottenham', display_name: 'Tottenham', short_name: 'TOT', aliases: ['spurs', 'tottenham', 'tottenham hotspur', 'tot', 'thfc'] },
];

export function normalizeText(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function loadTeams(db: D1Database): Promise<TeamRecord[]> {
  const { results } = await db
    .prepare('SELECT canonical_name, display_name, short_name, aliases_json FROM teams ORDER BY canonical_name')
    .all<{ canonical_name: string; display_name: string; short_name: string | null; aliases_json: string }>();
  if (!results.length) return BUILTIN_TEAMS;
  return results.map((r) => {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(r.aliases_json) as string[];
    } catch {
      aliases = [];
    }
    return {
      canonical_name: r.canonical_name,
      display_name: r.display_name,
      short_name: r.short_name,
      aliases,
    };
  });
}

export function resolveTeam(queryRaw: string, teams: TeamRecord[]): TeamResolution {
  const q = normalizeText(queryRaw);
  if (!q) return { status: 'unknown', query: queryRaw };

  // 1. Exact match on canonical, display, short_name, or any alias
  const exactMatches: TeamRecord[] = [];
  for (const t of teams) {
    const keys = new Set<string>([
      normalizeText(t.canonical_name),
      normalizeText(t.display_name),
      ...(t.short_name ? [normalizeText(t.short_name)] : []),
      ...t.aliases.map(normalizeText),
    ]);
    if (keys.has(q)) {
      exactMatches.push(t);
    }
  }
  if (exactMatches.length === 1) return { status: 'resolved', team: exactMatches[0] };
  if (exactMatches.length > 1) return { status: 'ambiguous', candidates: exactMatches };

  // 2. Token/substring match (only when query >= 3 chars to avoid noise)
  if (q.length >= 3) {
    const partialMatches: TeamRecord[] = [];
    for (const t of teams) {
      const pool = [
        normalizeText(t.canonical_name),
        normalizeText(t.display_name),
        ...t.aliases.map(normalizeText),
      ];
      if (pool.some((p) => p.includes(q))) {
        partialMatches.push(t);
      }
    }
    if (partialMatches.length === 1) return { status: 'resolved', team: partialMatches[0] };
    if (partialMatches.length > 1) return { status: 'ambiguous', candidates: partialMatches };
  }

  return { status: 'unknown', query: queryRaw };
}

export function splitMatchQuery(raw: string): { homeQuery: string; awayQuery: string | null } {
  const cleaned = raw.trim();
  const vsMatch = /^(.+?)\s+(?:vs\.?|v\.?|-)\s+(.+)$/i.exec(cleaned);
  if (vsMatch) {
    return { homeQuery: vsMatch[1].trim(), awayQuery: vsMatch[2].trim() };
  }
  return { homeQuery: cleaned, awayQuery: null };
}
