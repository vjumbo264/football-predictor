import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../src/index';
import type { OutgoingMessage } from '../src/telegram';
import type { Env } from '../src/types';
import { createTestDb } from './d1_sqlite_helper';

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 'test-ingest-secret',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-xyz',
    ALLOWED_TELEGRAM_IDS: '6339561761',
    ADMIN_TELEGRAM_IDS: '6339561761',
    FOOTBALL_API_KEY: 'test-api-key',
    API_DAILY_CAP: '80',
    LIVE_CACHE_SECONDS: '60',
    CLOSE_MATCH_GAP: '0.08',
    DEFAULT_LEAGUE: 'E0',
  };
}

test('webhook rejects missing or bad secret token with 403', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const res = await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    }),
    env,
  );
  assert.equal(res.status, 403);
});

test('unapproved user gets friendly private notice, cannot invoke commands, and notifies admin once', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const sent: OutgoingMessage[] = [];
  const update = {
    update_id: 1001,
    message: {
      message_id: 1,
      from: { id: 999888777, first_name: 'Stranger', username: 'stranger' },
      chat: { id: 999888777, type: 'private' },
      text: '/today',
    },
  };
  const res = await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify(update),
    }),
    env,
    '2026-11-25T10:00:00Z',
    {
      sender: async (m) => {
        sent.push(m);
      },
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.allowed, false);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chat_id, 999888777);
  assert.match(sent[0].text, /private/i);
  assert.equal(sent[1].chat_id, '6339561761');
  assert.match(sent[1].text, /999888777/);
});

test('allowed user gets /start onboarding + quick keyboard and /help screen', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const sent: OutgoingMessage[] = [];
  for (const cmd of ['/start', '/help']) {
    const res = await handleRequest(
      new Request('https://worker.test/telegram/webhook', {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 2001,
          message: {
            message_id: 2,
            from: { id: 6339561761, first_name: 'Victor' },
            chat: { id: 6339561761, type: 'private' },
            text: cmd,
          },
        }),
      }),
      env,
      '2026-11-25T10:00:00Z',
      {
        sender: async (m) => {
          sent.push(m);
        },
      },
    );
    assert.equal(res.status, 200);
  }
  assert.equal(sent.length, 3);
  assert.ok(sent[0].reply_markup && 'keyboard' in sent[0].reply_markup);
  assert.match(sent[1].text, /Welcome to Football Predictor/);
  assert.match(sent[1].text, /lock before kickoff/i);
  assert.match(sent[2].text, /Welcome to Football Predictor/);
});
