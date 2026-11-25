import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestData } from '../src/db';
import { computeBrierScore, computeLogLoss, runGradingPass } from '../src/grading';
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

async function sendPerfCmd(env: Env, nowIso: string): Promise<string> {
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
          text: '/performance',
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
  return sent[0].text;
}

test('grading cron is cheap when nothing is due, idempotent when finished, and never alters predictions', async () => {
  const { d1, raw } = createTestDb();
  const env = makeEnv(d1);

  // Future match -> nothing due -> 0 fetch calls
  await ingestData(
    d1,
    {
      model_version: { model_version: 'v1', config_hash: 'h1' },
      fixtures: [
        {
          match_id: 'E0:2026:arsenal:chelsea',
          league: 'E0',
          season: 2026,
          home_team: 'arsenal',
          away_team: 'chelsea',
          home_display: 'Arsenal',
          away_display: 'Chelsea',
          kickoff_utc: '2026-11-28T15:00:00Z',
          status: 'NS',
        },
      ],
      predictions: [
        {
          match_id: 'E0:2026:arsenal:chelsea',
          model_version: 'v1',
          config_hash: 'h1',
          kickoff_utc: '2026-11-28T15:00:00Z',
          p_home: 0.60,
          p_draw: 0.22,
          p_away: 0.18,
          predicted_outcome: 'H',
        },
      ],
    },
    '2026-11-28T10:00:00Z',
  );

  let fetchCalls = 0;
  const mockFplFetch: typeof fetch = async (input) => {
    fetchCalls += 1;
    const url = String(input);
    if (url.includes('bootstrap-static')) {
      return new Response(
        JSON.stringify({ teams: [{ id: 1, name: 'Arsenal' }, { id: 6, name: 'Chelsea' }] }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify([
        {
          id: 201,
          team_h: 1,
          team_a: 6,
          started: true,
          finished: true,
          finished_provisional: true,
          team_h_score: 2,
          team_a_score: 0,
        },
      ]),
      { status: 200 },
    );
  };

  // Before kickoff+105m -> cheap no-op
  const noop = await runGradingPass(env, '2026-11-28T15:30:00Z', mockFplFetch);
  assert.equal(noop.api_fetched, false);
  assert.equal(fetchCalls, 0);

  // After kickoff+105m -> fetches, records result, grades once
  const run1 = await runGradingPass(env, '2026-11-28T17:00:00Z', mockFplFetch);
  assert.equal(run1.api_fetched, true);
  assert.equal(run1.results_recorded, 1);
  assert.equal(run1.predictions_graded, 1);

  // Second pass -> match is now FT and graded -> 0 fetches, 0 new grades
  const beforeCalls = fetchCalls;
  const run2 = await runGradingPass(env, '2026-11-28T17:20:00Z', mockFplFetch);
  assert.equal(run2.api_fetched, false);
  assert.equal(run2.predictions_graded, 0);
  assert.equal(fetchCalls, beforeCalls);

  // Original prediction untouched, and prediction_results is append-only via triggers
  const pred = await d1
    .prepare('SELECT p_home, p_draw, p_away, predicted_outcome FROM predictions WHERE id = 1')
    .first<{ p_home: number; p_draw: number; p_away: number; predicted_outcome: string }>();
  assert.equal(pred?.p_home, 0.60);
  assert.equal(pred?.predicted_outcome, 'H');
  assert.throws(() => raw.exec('UPDATE prediction_results SET is_correct = 0 WHERE id = 1'), /append-only/i);
});

test('/performance matches hand-computed accuracy, always-home baseline, Brier, log loss, and calibration', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-28T20:00:00Z';

  // Insert 4 settled matches across 7d and 30d windows with known probabilities & outcomes:
  // M1 (2d ago): p=(0.70, 0.20, 0.10), pred=H, actual=H -> hit=1, home=1, brier=0.09+0.04+0.01=0.14, ll=-ln(0.70)
  // M2 (4d ago): p=(0.60, 0.25, 0.15), pred=H, actual=A -> hit=0, home=0, brier=0.36+0.0625+0.7225=1.145, ll=-ln(0.15)
  // M3 (15d ago): p=(0.20, 0.20, 0.60), pred=A, actual=A -> hit=1, home=0, brier=0.04+0.04+0.16=0.24, ll=-ln(0.60)
  // M4 (20d ago): p=(0.50, 0.30, 0.20), pred=H, actual=H -> hit=1, home=1, brier=0.25+0.09+0.04=0.38, ll=-ln(0.50)
  // Totals: N=4, Bot=3/4 (75.0%), AlwaysHome=2/4 (50.0%)
  // 7d: N=2, Bot=1/2 (50.0%), AlwaysHome=1/2 (50.0%)
  // 30d: N=4, Bot=3/4 (75.0%), AlwaysHome=2/4 (50.0%)
  // Mean Brier = (0.14 + 1.145 + 0.24 + 0.38) / 4 = 1.905 / 4 = 0.47625 -> 0.4763
  // Mean LogLoss = (-ln(0.70)-ln(0.15)-ln(0.60)-ln(0.50)) / 4 = 0.864526... -> 0.8645
  // Buckets:
  //   45-55%: M4 (0.50) -> 1/1 = 100.0%
  //   55-65%: M2 (0.60), M3 (0.60) -> 1/2 = 50.0%
  //   65%+: M1 (0.70) -> 1/1 = 100.0%

  const cases = [
    { id: 'E0:2026:t1:t2', ko: '2026-11-26T15:00:00Z', p: [0.70, 0.20, 0.10], pred: 'H', act: 'H', hg: 2, ag: 0 },
    { id: 'E0:2026:t3:t4', ko: '2026-11-24T15:00:00Z', p: [0.60, 0.25, 0.15], pred: 'H', act: 'A', hg: 0, ag: 1 },
    { id: 'E0:2026:t5:t6', ko: '2026-11-13T15:00:00Z', p: [0.20, 0.20, 0.60], pred: 'A', act: 'A', hg: 1, ag: 2 },
    { id: 'E0:2026:t7:t8', ko: '2026-11-08T15:00:00Z', p: [0.50, 0.30, 0.20], pred: 'H', act: 'H', hg: 1, ag: 0 },
  ] as const;

  for (const c of cases) {
    // Ingest fixture + prediction before its kickoff
    const preKo = new Date(Date.parse(c.ko) - 3600_000).toISOString();
    await ingestData(
      d1,
      {
        model_version: { model_version: 'v1', config_hash: 'h1' },
        fixtures: [
          {
            match_id: c.id,
            league: 'E0',
            season: 2026,
            home_team: c.id.split(':')[2],
            away_team: c.id.split(':')[3],
            home_display: c.id.split(':')[2],
            away_display: c.id.split(':')[3],
            kickoff_utc: c.ko,
            status: 'NS',
          },
        ],
        predictions: [
          {
            match_id: c.id,
            model_version: 'v1',
            config_hash: 'h1',
            kickoff_utc: c.ko,
            p_home: c.p[0],
            p_draw: c.p[1],
            p_away: c.p[2],
            predicted_outcome: c.pred,
          },
        ],
      },
      preKo,
    );
    await ingestData(
      d1,
      {
        results: [
          {
            match_id: c.id,
            home_goals: c.hg,
            away_goals: c.ag,
            actual_outcome: c.act,
            source: 'fpl',
          },
        ],
      },
      now,
    );
  }

  const graded = await runGradingPass(env, now);
  assert.equal(graded.predictions_graded, 4);

  const expectedBrier =
    (computeBrierScore(0.7, 0.2, 0.1, 'H') +
      computeBrierScore(0.6, 0.25, 0.15, 'A') +
      computeBrierScore(0.2, 0.2, 0.6, 'A') +
      computeBrierScore(0.5, 0.3, 0.2, 'H')) /
    4;
  const expectedLL =
    (computeLogLoss(0.7, 0.2, 0.1, 'H') +
      computeLogLoss(0.6, 0.25, 0.15, 'A') +
      computeLogLoss(0.2, 0.2, 0.6, 'A') +
      computeLogLoss(0.5, 0.3, 0.2, 'H')) /
    4;

  assert.ok(Math.abs(expectedBrier - 0.47625) < 1e-9);

  const perfText = await sendPerfCmd(env, now);
  assert.match(perfText, /Based on <b>4<\/b> settled/);
  assert.match(perfText, /Bot accuracy: <b>75\.0%<\/b> \(3\/4\)/);
  assert.match(perfText, /Always-home baseline: 50\.0% \(2\/4\)/);
  assert.match(perfText, /Mean Brier score: 0\.4763/);
  assert.match(perfText, new RegExp(`Mean Log loss: ${expectedLL.toFixed(4)}`));
  assert.match(perfText, /Last 7 days \(2\): Bot 50\.0% vs Always-home 50\.0%/);
  assert.match(perfText, /Last 30 days \(4\): Bot 75\.0% vs Always-home 50\.0%/);
  assert.match(perfText, /Said 45–55%: right 100\.0% \(1\/1\)/);
  assert.match(perfText, /Said 55–65%: right 50\.0% \(1\/2\)/);
  assert.match(perfText, /Said 65%\+: right 100\.0% \(1\/1\)/);
  assert.match(perfText, /Small samples are noisy/);
  assert.match(perfText, /Statistical estimates only/);
});
