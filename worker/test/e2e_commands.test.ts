import assert from 'node:assert/strict';
import test from 'node:test';
import { runGradingPass } from '../src/grading';
import { handleRequest } from '../src/index';
import type { OutgoingMessage } from '../src/telegram';
import type { Env } from '../src/types';
import { createTestDb } from './d1_sqlite_helper';

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 'e2e-ingest-secret',
    TELEGRAM_BOT_TOKEN: 'e2e-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'e2e-webhook-secret',
    ALLOWED_TELEGRAM_IDS: '6339561761',
    FOOTBALL_API_KEY: 'e2e-api-key',
    API_DAILY_CAP: '80',
    LIVE_CACHE_SECONDS: '60',
    CLOSE_MATCH_GAP: '0.08',
    DEFAULT_LEAGUE: 'E0',
  };
}

async function simWebhook(
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
        update_id: 9001,
        message: {
          message_id: 42,
          from: { id: 6339561761, first_name: 'Victor', username: 'vjumbo' },
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
  assert.equal(sent.length, 1);
  return sent[0].text;
}

test('end-to-end chain: ingest -> all commands -> grading finished match -> results & performance', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const t0 = '2026-11-23T12:00:00Z';

  // 1. Ingest pre-kickoff prediction for Brentford vs Everton (kickoff 20:00 UTC) + future Forest vs Chelsea
  const ingestRes = await handleRequest(
    new Request('https://worker.test/ingest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.INGEST_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model_version: { model_version: 'phase1-frozen', config_hash: 'cfg1' },
        teams: [
          { canonical_name: 'brentford', display_name: 'Brentford', short_name: 'BRE', aliases: ['bees'] },
          { canonical_name: 'everton', display_name: 'Everton', short_name: 'EVE', aliases: ['toffees'] },
          { canonical_name: 'nott m forest', display_name: "Nott'm Forest", short_name: 'NFO', aliases: ['forest'] },
          { canonical_name: 'chelsea', display_name: 'Chelsea', short_name: 'CHE', aliases: ['blues'] },
        ],
        fixtures: [
          {
            match_id: 'E0:2026:brentford:everton',
            league: 'E0',
            season: 2026,
            home_team: 'brentford',
            away_team: 'everton',
            home_display: 'Brentford',
            away_display: 'Everton',
            kickoff_utc: '2026-11-23T20:00:00Z',
            status: 'NS',
          },
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
            match_id: 'E0:2026:brentford:everton',
            model_version: 'phase1-frozen',
            config_hash: 'cfg1',
            kickoff_utc: '2026-11-23T20:00:00Z',
            p_home: 0.56,
            p_draw: 0.24,
            p_away: 0.20,
            xg_home: 1.85,
            xg_away: 0.95,
            predicted_outcome: 'H',
            summary_reason: 'Home edge on ratings.',
          },
        ],
        team_strengths: {
          league: 'E0',
          generated_at: t0,
          base: 0.1,
          home_adv: 0.25,
          rho: -0.06,
          teams: {
            'nott m forest': { attack: 0.1, defence: 0.0, elo: 10 },
            chelsea: { attack: 0.2, defence: -0.1, elo: 40 },
          },
        },
      }),
    }),
    env,
    t0,
  );
  assert.equal(ingestRes.status, 200);

  // 2. Verify commands before kickoff
  assert.match(await simWebhook(env, '/start', t0), /Premier League Match Predictor/);
  assert.match(await simWebhook(env, '/help', t0), /\/performance/);
  assert.match(await simWebhook(env, '/today', t0), /Brentford vs Everton<\/b> \(21:00 WAT\)/);
  assert.match(await simWebhook(env, '/tomorrow', t0), /No Premier League matches scheduled/);
  assert.match(await simWebhook(env, '/match Forest vs Chelsea', t0), /PROVISIONAL/);

  // 3. Match goes live -> /live
  const liveFetch: typeof fetch = async (input) => {
    if (String(input).includes('api-sports.io')) {
      return new Response(
        JSON.stringify({
          errors: [],
          response: [
            {
              fixture: { status: { short: '1H', elapsed: 33 } },
              teams: { home: { name: 'Brentford' }, away: { name: 'Everton' } },
              goals: { home: 2, away: 0 },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('[]', { status: 200 });
  };
  const liveReply = await simWebhook(env, '/live', '2026-11-23T20:35:00Z', liveFetch);
  assert.match(liveReply, /Brentford 2 - 0 Everton<\/b> \(33'\)/);

  // 4. Match finishes -> grading pass records 4-0 result and grades prediction
  const gradeFetch: typeof fetch = async (input) => {
    if (String(input).includes('bootstrap-static')) {
      return new Response(
        JSON.stringify({ teams: [{ id: 4, name: 'Brentford' }, { id: 9, name: 'Everton' }] }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify([
        {
          id: 103,
          team_h: 4,
          team_a: 9,
          started: true,
          finished: true,
          finished_provisional: true,
          team_h_score: 4,
          team_a_score: 0,
        },
      ]),
      { status: 200 },
    );
  };
  const gradeSummary = await runGradingPass(env, '2026-11-23T22:15:00Z', gradeFetch);
  assert.equal(gradeSummary.results_recorded, 1);
  assert.equal(gradeSummary.predictions_graded, 1);

  // 5. /results and /performance reflect the settled match
  const resultsReply = await simWebhook(env, '/results', '2026-11-23T22:20:00Z');
  assert.match(resultsReply, /Brentford 4 - 0 Everton/);
  assert.match(resultsReply, /✅ Hit/);

  const perfReply = await simWebhook(env, '/performance', '2026-11-23T22:20:00Z');
  assert.match(perfReply, /Bot accuracy: <b>100\.0%<\/b> \(1\/1\)/);
  assert.match(perfReply, /Said 55–65%: right 100\.0% \(1\/1\)/);
});
