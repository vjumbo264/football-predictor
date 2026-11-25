import type {
  IngestFixture,
  IngestPayload,
  IngestPrediction,
} from './types';

export class IngestValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface IngestSummary {
  teams_upserted: number;
  fixtures_upserted: number;
  results_upserted: number;
  predictions_inserted: number;
  predictions_skipped_existing: number;
}

export function utcDateStr(nowIso: string): string {
  return nowIso.slice(0, 10);
}

export async function getApiUsage(
  db: D1Database,
  provider: string,
  dateStr: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT calls FROM api_usage WHERE usage_date = ? AND provider = ?')
    .bind(dateStr, provider)
    .first<{ calls: number }>();
  return row?.calls ?? 0;
}

export async function recordApiCall(
  db: D1Database,
  provider: string,
  cap: number,
  nowIso: string,
): Promise<{ allowed: boolean; used: number; cap: number }> {
  const dateStr = utcDateStr(nowIso);
  const used = await getApiUsage(db, provider, dateStr);
  if (used >= cap) {
    return { allowed: false, used, cap };
  }
  await db
    .prepare(
      `INSERT INTO api_usage (usage_date, provider, calls, last_called_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (usage_date, provider)
       DO UPDATE SET calls = calls + 1, last_called_at = excluded.last_called_at`,
    )
    .bind(dateStr, provider, nowIso)
    .run();
  return { allowed: true, used: used + 1, cap };
}

export async function getCachedValue<T>(
  db: D1Database,
  key: string,
  nowIso: string,
  allowExpired = false,
): Promise<{ data: T; fetched_at: string; expired: boolean } | null> {
  const row = await db
    .prepare('SELECT payload_json, fetched_at, expires_at FROM live_cache WHERE cache_key = ?')
    .bind(key)
    .first<{ payload_json: string; fetched_at: string; expires_at: string }>();
  if (!row) return null;
  const expired = Date.parse(row.expires_at) <= Date.parse(nowIso);
  if (expired && !allowExpired) return null;
  return {
    data: JSON.parse(row.payload_json) as T,
    fetched_at: row.fetched_at,
    expired,
  };
}

export async function setCachedValue(
  db: D1Database,
  key: string,
  data: unknown,
  ttlSeconds: number,
  nowIso: string,
): Promise<void> {
  const expiresAt = new Date(Date.parse(nowIso) + ttlSeconds * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO live_cache (cache_key, payload_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (cache_key)
       DO UPDATE SET payload_json = excluded.payload_json,
                     fetched_at = excluded.fetched_at,
                     expires_at = excluded.expires_at`,
    )
    .bind(key, JSON.stringify(data), nowIso, expiresAt)
    .run();
}

function validatePrediction(p: IngestPrediction, nowMs: number, fixtureMap: Map<string, IngestFixture>): void {
  if (!p.match_id || !p.model_version || !p.config_hash || !p.kickoff_utc) {
    throw new IngestValidationError('Prediction missing required identifier or kickoff fields');
  }
  const sum = p.p_home + p.p_draw + p.p_away;
  if (
    !Number.isFinite(p.p_home) ||
    !Number.isFinite(p.p_draw) ||
    !Number.isFinite(p.p_away) ||
    p.p_home < 0 ||
    p.p_draw < 0 ||
    p.p_away < 0 ||
    Math.abs(sum - 1.0) > 0.005
  ) {
    throw new IngestValidationError(`Invalid 1X2 probabilities for ${p.match_id} (sum=${sum})`);
  }
  if (!['H', 'D', 'A'].includes(p.predicted_outcome)) {
    throw new IngestValidationError(`Invalid predicted_outcome for ${p.match_id}`);
  }
  const predKickoffMs = Date.parse(p.kickoff_utc);
  if (!Number.isFinite(predKickoffMs) || predKickoffMs <= nowMs) {
    throw new IngestValidationError(
      `Cannot ingest prediction for match ${p.match_id} that has already started`,
    );
  }
  const fx = fixtureMap.get(p.match_id);
  if (!fx) {
    throw new IngestValidationError(`Unknown fixture for prediction ${p.match_id}`);
  }
  const fxKickoffMs = Date.parse(fx.kickoff_utc);
  if (fx.status !== 'NS' || !Number.isFinite(fxKickoffMs) || fxKickoffMs <= nowMs) {
    throw new IngestValidationError(
      `Cannot ingest prediction for match ${p.match_id} (status=${fx.status}, kickoff=${fx.kickoff_utc})`,
    );
  }
}

export async function ingestData(
  db: D1Database,
  payload: IngestPayload,
  nowIso: string = new Date().toISOString(),
): Promise<IngestSummary> {
  const nowMs = Date.parse(nowIso);
  const summary: IngestSummary = {
    teams_upserted: 0,
    fixtures_upserted: 0,
    results_upserted: 0,
    predictions_inserted: 0,
    predictions_skipped_existing: 0,
  };

  // Build fixture lookup from payload + existing DB before validating predictions
  const fixtureMap = new Map<string, IngestFixture>();
  for (const fx of payload.fixtures ?? []) {
    fixtureMap.set(fx.match_id, fx);
  }
  for (const pred of payload.predictions ?? []) {
    if (!fixtureMap.has(pred.match_id)) {
      const existing = await db
        .prepare(
          'SELECT match_id, league, season, home_team, away_team, home_display, away_display, kickoff_utc, status, provider, provider_id FROM fixtures WHERE match_id = ?',
        )
        .bind(pred.match_id)
        .first<IngestFixture>();
      if (existing) {
        fixtureMap.set(existing.match_id, existing);
      }
    }
  }

  for (const pred of payload.predictions ?? []) {
    validatePrediction(pred, nowMs, fixtureMap);
  }

  if (payload.model_version) {
    const mv = payload.model_version;
    await db
      .prepare(
        `INSERT INTO model_versions (model_version, config_hash, description, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (model_version) DO NOTHING`,
      )
      .bind(mv.model_version, mv.config_hash, mv.description ?? null, nowIso)
      .run();
  }

  for (const t of payload.teams ?? []) {
    await db
      .prepare(
        `INSERT INTO teams (canonical_name, display_name, short_name, aliases_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (canonical_name)
         DO UPDATE SET display_name = excluded.display_name,
                       short_name = COALESCE(excluded.short_name, teams.short_name),
                       aliases_json = excluded.aliases_json,
                       updated_at = excluded.updated_at`,
      )
      .bind(
        t.canonical_name,
        t.display_name,
        t.short_name ?? null,
        JSON.stringify(t.aliases ?? []),
        nowIso,
      )
      .run();
    summary.teams_upserted += 1;
  }

  for (const fx of payload.fixtures ?? []) {
    await db
      .prepare(
        `INSERT INTO fixtures (match_id, league, season, home_team, away_team, home_display, away_display, kickoff_utc, status, provider, provider_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (match_id)
         DO UPDATE SET kickoff_utc = excluded.kickoff_utc,
                       status = excluded.status,
                       home_display = excluded.home_display,
                       away_display = excluded.away_display,
                       provider = COALESCE(excluded.provider, fixtures.provider),
                       provider_id = COALESCE(excluded.provider_id, fixtures.provider_id),
                       updated_at = excluded.updated_at`,
      )
      .bind(
        fx.match_id,
        fx.league,
        fx.season,
        fx.home_team,
        fx.away_team,
        fx.home_display,
        fx.away_display,
        fx.kickoff_utc,
        fx.status,
        fx.provider ?? null,
        fx.provider_id ?? null,
        nowIso,
      )
      .run();
    summary.fixtures_upserted += 1;
  }

  for (const r of payload.results ?? []) {
    await db
      .prepare(
        `INSERT INTO results (match_id, home_goals, away_goals, actual_outcome, status, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (match_id) DO NOTHING`,
      )
      .bind(
        r.match_id,
        r.home_goals,
        r.away_goals,
        r.actual_outcome,
        r.status ?? 'FT',
        r.source,
        nowIso,
      )
      .run();
    await db
      .prepare("UPDATE fixtures SET status = 'FT', updated_at = ? WHERE match_id = ? AND status != 'FT'")
      .bind(nowIso, r.match_id)
      .run();
    summary.results_upserted += 1;
  }

  // Strictly insert-only predictions (no UPDATE, no REPLACE)
  for (const p of payload.predictions ?? []) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO model_versions (model_version, config_hash, description, created_at)
         VALUES (?, ?, NULL, ?)`,
      )
      .bind(p.model_version, p.config_hash, nowIso)
      .run();

    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO predictions (
           match_id, model_version, config_hash, kickoff_utc,
           p_home, p_draw, p_away, p_over25, p_btts, xg_home, xg_away,
           predicted_outcome, summary_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.match_id,
        p.model_version,
        p.config_hash,
        p.kickoff_utc,
        p.p_home,
        p.p_draw,
        p.p_away,
        p.p_over25 ?? null,
        p.p_btts ?? null,
        p.xg_home ?? null,
        p.xg_away ?? null,
        p.predicted_outcome,
        p.summary_reason ?? null,
        nowIso,
      )
      .run();

    const changes = res.meta?.changes ?? 0;
    if (changes > 0) {
      summary.predictions_inserted += 1;
    } else {
      summary.predictions_skipped_existing += 1;
    }
  }

  if (payload.team_strengths?.league) {
    await setCachedValue(
      db,
      `team_strengths:${payload.team_strengths.league}`,
      payload.team_strengths,
      7 * 24 * 3600,
      nowIso,
    );
  }

  return summary;
}
