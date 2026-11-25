import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestData } from '../src/db';
import { handleRequest } from '../src/index';
import type { OutgoingMessage } from '../src/telegram';
import type { Env } from '../src/types';
import { createTestDb } from './d1_sqlite_helper';

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 'test-ingest-secret',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    ALLOWED_TELEGRAM_IDS: '6339561761',
    FOOTBALL_API_KEY: 'test-api-key',
    API_DAILY_CAP: '80',
    LIVE_CACHE_SECONDS: '60',
    CLOSE_MATCH_GAP: '0.08',
    DEFAULT_LEAGUE: 'E0',
  };
}

async function sendBotCmd(env: Env, text: string, nowIso: string): Promise<string> {
  const sent: OutgoingMessage[] = [];
  const res = await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 6339561761, first_name: 'Victor' },
          chat: { id: 6339561761, type: 'private' },
          text,
        },
      }),
    }),
    env,
    nowIso,
    {
      sender: async (m) => {
        sent.push(m);
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  return sent[0].text;
}

test('/today, /tomorrow, and /match cover Lagos time, close-match, missing, unknown, ambiguous, and provisional', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-27T10:00:00Z'; // 11:00 WAT on 2026-11-27

  await ingestData(
    d1,
    {
      model_version: { model_version: 'v1', config_hash: 'h1' },
      teams: [
        { canonical_name: 'arsenal', display_name: 'Arsenal', short_name: 'ARS', aliases: ['gunners'] },
        { canonical_name: 'chelsea', display_name: 'Chelsea', short_name: 'CHE', aliases: ['blues'] },
        { canonical_name: 'manchester united', display_name: 'Man Utd', short_name: 'MUN', aliases: ['man u', 'united'] },
        { canonical_name: 'manchester city', display_name: 'Man City', short_name: 'MCI', aliases: ['city'] },
        { canonical_name: 'tottenham', display_name: 'Tottenham', short_name: 'TOT', aliases: ['spurs'] },
        { canonical_name: 'nott m forest', display_name: "Nott'm Forest", short_name: 'NFO', aliases: ['forest'] },
      ],
      fixtures: [
        // Past settled match for form & H2H
        {
          match_id: 'E0:2026:chelsea:arsenal',
          league: 'E0',
          season: 2026,
          home_team: 'chelsea',
          away_team: 'arsenal',
          home_display: 'Chelsea',
          away_display: 'Arsenal',
          kickoff_utc: '2026-11-10T15:00:00Z',
          status: 'FT',
        },
        // Today in Lagos (20:00 UTC = 21:00 WAT 2026-11-27) -> locked close match
        {
          match_id: 'E0:2026:nott-m-forest:chelsea',
          league: 'E0',
          season: 2026,
          home_team: 'nott m forest',
          away_team: 'chelsea',
          home_display: "Nott'm Forest",
          away_display: 'Chelsea',
          kickoff_utc: '2026-11-27T20:00:00Z',
          status: 'NS',
        },
        // 23:30 UTC on 2026-11-27 = 00:30 WAT on 2026-11-28 (Tomorrow in Lagos!) -> missing prediction (<36h)
        {
          match_id: 'E0:2026:arsenal:tottenham',
          league: 'E0',
          season: 2026,
          home_team: 'arsenal',
          away_team: 'tottenham',
          home_display: 'Arsenal',
          away_display: 'Tottenham',
          kickoff_utc: '2026-11-27T23:30:00Z',
          status: 'NS',
        },
        // > 36h away -> provisional only, NOT stored in predictions table
        {
          match_id: 'E0:2026:manchester-united:manchester-city',
          league: 'E0',
          season: 2026,
          home_team: 'manchester united',
          away_team: 'manchester city',
          home_display: 'Man Utd',
          away_display: 'Man City',
          kickoff_utc: '2026-11-30T15:00:00Z',
          status: 'NS',
        },
      ],
      results: [
        {
          match_id: 'E0:2026:chelsea:arsenal',
          home_goals: 1,
          away_goals: 2,
          actual_outcome: 'A',
          source: 'fpl',
        },
      ],
      predictions: [
        {
          match_id: 'E0:2026:nott-m-forest:chelsea',
          model_version: 'v1',
          config_hash: 'h1',
          kickoff_utc: '2026-11-27T20:00:00Z',
          p_home: 0.37,
          p_draw: 0.27,
          p_away: 0.36,
          xg_home: 1.35,
          xg_away: 1.32,
          predicted_outcome: 'H',
          summary_reason: 'Tight matchup on ratings.',
        },
      ],
      team_strengths: {
        league: 'E0',
        generated_at: now,
        base: 0.1,
        home_adv: 0.25,
        rho: -0.06,
        teams: {
          'manchester united': { attack: 0.1, defence: 0.0, elo: 50 },
          'manchester city': { attack: 0.35, defence: -0.25, elo: 120 },
        },
      },
    },
    now,
  );

  // 1. /today shows Forest vs Chelsea at 21:00 WAT with close-match marker
  const todayMsg = await sendBotCmd(env, '/today', now);
  assert.match(todayMsg, /2026-11-27 WAT/);
  assert.match(todayMsg, /Nott'm Forest vs Chelsea<\/b> \(21:00 WAT\)/);
  assert.match(todayMsg, /Close match, draw risk/);
  assert.doesNotMatch(todayMsg, /Arsenal vs Tottenham/);

  // 2. /tomorrow shows Arsenal vs Tottenham at 00:30 WAT (Lagos timezone crossover) with missing-prediction message
  const tmrMsg = await sendBotCmd(env, '/tomorrow', now);
  assert.match(tmrMsg, /2026-11-28 WAT/);
  assert.match(tmrMsg, /Arsenal vs Tottenham<\/b> \(00:30 WAT\)/);
  assert.match(tmrMsg, /Predictions not ready yet/);

  // 3. No matches day
  const emptyDay = await sendBotCmd(env, '/today', '2026-12-10T10:00:00Z');
  assert.match(emptyDay, /No Premier League matches scheduled/);

  // 4. /match with single nickname "Man U" -> >36h provisional forecast, NOT stored in DB
  const provMsg = await sendBotCmd(env, '/match Man U', now);
  assert.match(provMsg, /Man Utd vs Man City/);
  assert.match(provMsg, /within 36 hours/);
  assert.match(provMsg, /PROVISIONAL/);
  assert.match(provMsg, /Statistical estimates only/);

  const predCount = await d1.prepare('SELECT COUNT(*) AS c FROM predictions').first<{ c: number }>();
  assert.equal(predCount?.c, 1);

  // 5. /match with Forest vs Chelsea -> locked prediction + recent form
  const lockedMsg = await sendBotCmd(env, '/match Forest vs Chelsea', now);
  assert.match(lockedMsg, /Locked prediction:/);
  assert.match(lockedMsg, /Expected goals: 1\.35 – 1\.32/);
  assert.match(lockedMsg, /Chelsea: L 1-2 vs Arsenal/);

  // 6. Unknown team
  const unkMsg = await sendBotCmd(env, '/match Atlantis FC', now);
  assert.match(unkMsg, /Could not recognize/);

  // 7. Ambiguous team ("man" matches Man Utd and Man City)
  const ambMsg = await sendBotCmd(env, '/match man', now);
  assert.match(ambMsg, /Multiple teams match/);
  assert.match(ambMsg, /Man City/);
  assert.match(ambMsg, /Man Utd/);
});
