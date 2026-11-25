import assert from 'node:assert/strict';
import test from 'node:test';
import { getApiUsage, ingestData, recordApiCall } from '../src/db';
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

async function sendCmd(
  env: Env,
  text: string,
  nowIso: string,
  fetchFn?: typeof fetch,
): Promise<string> {
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
      fetchFn,
    },
  );
  assert.equal(res.status, 200);
  return sent[0].text;
}

test('/live uses 60s cache and enforces 80/day budget fallback across NS -> LIVE -> FT lifecycle', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const preKickoff = '2026-11-27T10:00:00Z';

  // 1. Scheduled (NS) match with locked prediction
  await ingestData(
    d1,
    {
      model_version: { model_version: 'v1', config_hash: 'h1' },
      teams: [
        { canonical_name: 'nott m forest', display_name: "Nott'm Forest", short_name: 'NFO', aliases: ['forest'] },
        { canonical_name: 'chelsea', display_name: 'Chelsea', short_name: 'CHE', aliases: ['blues'] },
      ],
      fixtures: [
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
      ],
      predictions: [
        {
          match_id: 'E0:2026:nott-m-forest:chelsea',
          model_version: 'v1',
          config_hash: 'h1',
          kickoff_utc: '2026-11-27T20:00:00Z',
          p_home: 0.48,
          p_draw: 0.26,
          p_away: 0.26,
          predicted_outcome: 'H',
        },
      ],
    },
    preKickoff,
  );

  // 2. Match goes LIVE -> API-Football called once, cached for 60s
  let apiCalls = 0;
  const mockLiveFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('api-sports.io')) {
      apiCalls += 1;
      return new Response(
        JSON.stringify({
          errors: [],
          response: [
            {
              fixture: { status: { short: '2H', elapsed: 64 } },
              teams: { home: { name: 'Nottingham Forest' }, away: { name: 'Chelsea' } },
              goals: { home: 2, away: 1 },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('[]', { status: 200 });
  };

  const live1 = await sendCmd(env, '/live', '2026-11-27T21:20:00Z', mockLiveFetch);
  assert.equal(apiCalls, 1);
  assert.match(live1, /Nott'm Forest 2 - 1 Chelsea<\/b> \(64'\)/);
  assert.match(live1, /Locked pick: <b>Nott'm Forest win<\/b>/);

  // Second /live within 60s hits cache -> 0 new API calls
  const live2 = await sendCmd(env, '/live', '2026-11-27T21:20:30Z', mockLiveFetch);
  assert.equal(apiCalls, 1);
  assert.match(live2, /Nott'm Forest 2 - 1 Chelsea/);
  assert.equal(await getApiUsage(d1, 'api_football', '2026-11-27'), 1);

  // 3. Exhaust remaining budget (79 more calls -> 80/80) and verify graceful fallback after cache expires
  for (let i = 0; i < 79; i++) {
    await recordApiCall(d1, 'api_football', 80, '2026-11-27T21:21:00Z');
  }
  const fplFallbackFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('api-sports.io')) {
      throw new Error('Must not call API-Football when budget exhausted');
    }
    if (url.includes('bootstrap-static')) {
      return new Response(
        JSON.stringify({
          teams: [
            { id: 18, name: "Nott'm Forest" },
            { id: 6, name: 'Chelsea' },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify([
        {
          id: 119,
          team_h: 18,
          team_a: 6,
          started: true,
          finished: false,
          finished_provisional: false,
          minutes: 78,
          team_h_score: 2,
          team_a_score: 1,
        },
      ]),
      { status: 200 },
    );
  };

  const liveFallback = await sendCmd(env, '/live', '2026-11-27T21:35:00Z', fplFallbackFetch);
  assert.match(liveFallback, /Daily API-Football budget \(80\/80\) reached/);
  assert.match(liveFallback, /Nott'm Forest 2 - 1 Chelsea<\/b> \(78'\)/);

  // 4. Match finishes (FT) -> /results shows Hit
  await ingestData(
    d1,
    {
      results: [
        {
          match_id: 'E0:2026:nott-m-forest:chelsea',
          home_goals: 2,
          away_goals: 1,
          actual_outcome: 'H',
          source: 'fpl',
        },
      ],
    },
    '2026-11-27T22:10:00Z',
  );

  const resMsg = await sendCmd(env, '/results', '2026-11-27T22:15:00Z');
  assert.match(resMsg, /Nott'm Forest 2 - 1 Chelsea/);
  assert.match(resMsg, /✅ Hit/);
});
