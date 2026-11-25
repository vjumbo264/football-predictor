import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/index';
import { recordApiCall } from '../src/db';
import type { Env } from '../src/types';
import { createTestDb } from './d1_sqlite_helper';

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 'test-ingest-secret-123',
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

test('/health responds 200 with DB ok and api_budget', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const res = await handleRequest(new Request('https://worker.test/health'), env, '2026-11-25T10:00:00Z');
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.api_budget.used, 0);
  assert.equal(body.api_budget.cap, 80);
});

test('/ingest rejects missing or invalid Bearer auth', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);

  const res1 = await handleRequest(
    new Request('https://worker.test/ingest', { method: 'POST', body: '{}' }),
    env,
  );
  assert.equal(res1.status, 401);

  const res2 = await handleRequest(
    new Request('https://worker.test/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  assert.equal(res2.status, 401);
});

test('/ingest rejects predictions for matches that have already started', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-27T20:05:00Z';

  const payload = {
    model_version: { model_version: 'v1', config_hash: 'abc123' },
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
        config_hash: 'abc123',
        kickoff_utc: '2026-11-27T20:00:00Z',
        p_home: 0.3,
        p_draw: 0.25,
        p_away: 0.45,
        predicted_outcome: 'A',
      },
    ],
  };

  const res = await handleRequest(
    new Request('https://worker.test/ingest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.INGEST_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }),
    env,
    now,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.ok, false);
  assert.match(body.error, /already started/i);
});

test('/ingest inserts pre-kickoff prediction once and prevents updates or deletes', async () => {
  const { d1, raw } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-27T05:00:00Z';

  const payload = {
    model_version: { model_version: 'v1', config_hash: 'abc123' },
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
        config_hash: 'abc123',
        kickoff_utc: '2026-11-27T20:00:00Z',
        p_home: 0.30,
        p_draw: 0.25,
        p_away: 0.45,
        predicted_outcome: 'A',
      },
    ],
  };

  const res1 = await handleRequest(
    new Request('https://worker.test/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
    now,
  );
  assert.equal(res1.status, 200);
  const b1 = (await res1.json()) as any;
  assert.equal(b1.summary.predictions_inserted, 1);

  // Resubmit modified probabilities for same match + model_version -> skipped, original preserved
  payload.predictions[0].p_home = 0.8;
  payload.predictions[0].p_away = 0.05;
  payload.predictions[0].p_draw = 0.15;
  payload.predictions[0].predicted_outcome = 'H';

  const res2 = await handleRequest(
    new Request('https://worker.test/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
    now,
  );
  assert.equal(res2.status, 200);
  const b2 = (await res2.json()) as any;
  assert.equal(b2.summary.predictions_inserted, 0);
  assert.equal(b2.summary.predictions_skipped_existing, 1);

  const stored = await d1
    .prepare('SELECT p_home, predicted_outcome FROM predictions WHERE match_id = ?')
    .bind('E0:2026:nott-m-forest:chelsea')
    .first<{ p_home: number; predicted_outcome: string }>();
  assert.equal(stored?.p_home, 0.30);
  assert.equal(stored?.predicted_outcome, 'A');

  // Verify SQLite triggers block UPDATE and DELETE on predictions
  assert.throws(() => raw.exec("UPDATE predictions SET p_home = 0.99 WHERE id = 1"), /insert-only/i);
  assert.throws(() => raw.exec("DELETE FROM predictions WHERE id = 1"), /insert-only/i);
});

test('api_usage enforces daily cap of 80 calls', async () => {
  const { d1 } = createTestDb();
  const now = '2026-11-25T12:00:00Z';
  for (let i = 0; i < 80; i++) {
    const r = await recordApiCall(d1, 'api_football', 80, now);
    assert.equal(r.allowed, true);
  }
  const over = await recordApiCall(d1, 'api_football', 80, now);
  assert.equal(over.allowed, false);
  assert.equal(over.used, 80);
});
