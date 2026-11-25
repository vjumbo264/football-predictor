import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestData } from '../src/db';
import { handleRequest } from '../src/index';
import type {
  AnswerCallbackPayload,
  EditMessagePayload,
  OutgoingMessage,
  TelegramClient,
} from '../src/telegram';
import type { Env, InlineKeyboardButton } from '../src/types';
import { createTestDb } from './d1_sqlite_helper';

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 's',
    TELEGRAM_BOT_TOKEN: 'bot-tok',
    TELEGRAM_WEBHOOK_SECRET: 'wh-sec',
    ALLOWED_TELEGRAM_IDS: '6339561761',
    ADMIN_TELEGRAM_IDS: '6339561761',
    FOOTBALL_API_KEY: 'k',
    API_DAILY_CAP: '80',
    LIVE_CACHE_SECONDS: '60',
    CLOSE_MATCH_GAP: '0.08',
    DEFAULT_LEAGUE: 'E0',
  };
}

function createRecordingClient() {
  const sent: OutgoingMessage[] = [];
  const edited: EditMessagePayload[] = [];
  const answered: AnswerCallbackPayload[] = [];
  const client: TelegramClient = {
    async sendMessage(m) {
      sent.push(m);
    },
    async editMessageText(m) {
      edited.push(m);
      return { ok: true };
    },
    async answerCallbackQuery(p) {
      answered.push(p);
    },
  };
  return { sent, edited, answered, client };
}

function flattenCallbacks(rows?: InlineKeyboardButton[][]): string[] {
  return (rows ?? []).flat().map((b) => b.callback_data);
}

test('K2: /menu opens home screen and every home button edits message with Back & Home and answers callback', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-27T10:00:00Z';

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
          kickoff_utc: '2026-11-27T16:30:00Z',
          status: 'NS',
        },
      ],
      predictions: [
        {
          match_id: 'E0:2026:arsenal:chelsea',
          model_version: 'v1',
          config_hash: 'h1',
          kickoff_utc: '2026-11-27T16:30:00Z',
          p_home: 0.5,
          p_draw: 0.25,
          p_away: 0.25,
          predicted_outcome: 'H',
        },
      ],
    },
    now,
  );

  const rec = createRecordingClient();
  const menuRes = await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 6339561761, first_name: 'Victor' },
          chat: { id: 6339561761, type: 'private' },
          text: '/menu',
        },
      }),
    }),
    env,
    now,
    { telegram: rec.client },
  );
  assert.equal(menuRes.status, 200);
  assert.equal(rec.sent.length, 1);
  assert.match(rec.sent[0].text, /Main Menu/);

  const homeMarkup = rec.sent[0].reply_markup;
  assert.ok(homeMarkup && 'inline_keyboard' in homeMarkup);
  const homeCallbacks = flattenCallbacks(homeMarkup.inline_keyboard);
  assert.equal(homeCallbacks.length, 7);
  for (const cb of homeCallbacks) {
    assert.ok(cb.startsWith('v1:'));
    assert.ok(Buffer.byteLength(cb, 'utf-8') <= 64);
  }

  // Tap every single button on the Home screen
  const liveFetch: typeof fetch = async () => new Response('[]', { status: 200 });
  for (let i = 0; i < homeCallbacks.length; i++) {
    const cb = homeCallbacks[i];
    const cqRes = await handleRequest(
      new Request('https://worker.test/telegram/webhook', {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 10 + i,
          callback_query: {
            id: `cq-${i}`,
            from: { id: 6339561761, first_name: 'Victor' },
            message: {
              message_id: 10,
              chat: { id: 6339561761, type: 'private' },
            },
            data: cb,
          },
        }),
      }),
      env,
      now,
      { telegram: rec.client, fetchFn: liveFetch },
    );
    assert.equal(cqRes.status, 200);
    assert.equal(rec.answered[i].callback_query_id, `cq-${i}`);
    const edit = rec.edited[i];
    assert.equal(edit.message_id, 10);
    const btnLabels = (edit.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text);
    assert.ok(btnLabels.some((t) => t.includes('Home')), `Screen ${cb} missing Home button`);
    assert.ok(btnLabels.some((t) => t.includes('Back')), `Screen ${cb} missing Back button`);
  }
});

test('K2: editMessageText falls back to sendMessage on "message is not modified" and "message to edit not found"', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-27T10:00:00Z';

  const errorDescriptions = [
    'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
    'Bad Request: message to edit not found',
  ];

  for (const desc of errorDescriptions) {
    const apiCalls: Array<{ method: string; body: any }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = url.split('/').pop() || '';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      apiCalls.push({ method, body });
      if (method === 'editMessageText') {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: desc }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };

    const res = await handleRequest(
      new Request('https://worker.test/telegram/webhook', {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 50,
          callback_query: {
            id: 'cq-fallback',
            from: { id: 6339561761, first_name: 'Victor' },
            message: { message_id: 99, chat: { id: 6339561761, type: 'private' } },
            data: 'v1:home',
          },
        }),
      }),
      env,
      now,
      { fetchFn: mockFetch },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      apiCalls.map((c) => c.method),
      ['answerCallbackQuery', 'editMessageText', 'sendMessage'],
    );
    assert.match(apiCalls[2].body.text, /Main Menu/);
  }
});

test('K2: non-allowed user tapping inline button is ignored after answerCallbackQuery', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const rec = createRecordingClient();
  const res = await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 99,
        callback_query: {
          id: 'cq-stranger',
          from: { id: 12345678, first_name: 'Intruder' },
          message: { message_id: 5, chat: { id: 12345678, type: 'private' } },
          data: 'v1:home',
        },
      }),
    }),
    env,
    '2026-11-27T10:00:00Z',
    { telegram: rec.client },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.allowed, false);
  assert.equal(rec.answered.length, 1);
  assert.equal(rec.edited.length, 0);
  assert.equal(rec.sent.length, 0);
});
