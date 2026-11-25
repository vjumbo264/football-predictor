import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestData } from '../src/db';
import { runMorningDigest } from '../src/morning';
import type { OutgoingMessage } from '../src/telegram';
import type { Env } from '../src/types';
import { createTestDb } from './d1_sqlite_helper';

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 's',
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_WEBHOOK_SECRET: 'w',
    ALLOWED_TELEGRAM_IDS: '6339561761',
    FOOTBALL_API_KEY: 'k',
    API_DAILY_CAP: '80',
    LIVE_CACHE_SECONDS: '60',
    CLOSE_MATCH_GAP: '0.08',
    DEFAULT_LEAGUE: 'E0',
  };
}

test('morning digest sends once per Lagos day after 08:00 WAT when matches exist and never duplicates', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const sent: OutgoingMessage[] = [];
  const sender = async (m: OutgoingMessage) => {
    sent.push(m);
  };

  await ingestData(
    d1,
    {
      model_version: { model_version: 'v1', config_hash: 'h1' },
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
          p_home: 0.37,
          p_draw: 0.26,
          p_away: 0.37,
          predicted_outcome: 'H',
        },
      ],
    },
    '2026-11-27T05:00:00Z',
  );

  // Before 08:00 WAT (06:30 UTC = 07:30 WAT) -> skip
  const early = await runMorningDigest(env, '2026-11-27T06:30:00Z', sender);
  assert.equal(early.sent, 0);
  assert.equal(early.reason, 'before_08_wat');

  // At 08:20 WAT (07:20 UTC) -> sends once
  const first = await runMorningDigest(env, '2026-11-27T07:20:00Z', sender);
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Morning Matchday Brief/);
  assert.match(sent[0].text, /Nott'm Forest vs Chelsea/);

  // Second run same day -> does NOT duplicate
  const second = await runMorningDigest(env, '2026-11-27T07:40:00Z', sender);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 1);
  assert.equal(sent.length, 1);
});
