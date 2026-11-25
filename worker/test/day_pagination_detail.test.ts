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
import type { Env, IngestFixture } from '../src/types';
import { createTestDb } from './d1_sqlite_helper';

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 's',
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_WEBHOOK_SECRET: 'w',
    ALLOWED_TELEGRAM_IDS: '6339561761',
    ADMIN_TELEGRAM_IDS: '6339561761',
    FOOTBALL_API_KEY: 'k',
    API_DAILY_CAP: '80',
    LIVE_CACHE_SECONDS: '60',
    CLOSE_MATCH_GAP: '0.08',
    DEFAULT_LEAGUE: 'E0',
  };
}

function makeRecorder() {
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

async function tap(env: Env, data: string, nowIso: string, client: TelegramClient) {
  const res = await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1,
        callback_query: {
          id: `cq-${data}`,
          from: { id: 6339561761, first_name: 'Victor' },
          message: { message_id: 77, chat: { id: 6339561761, type: 'private' } },
          data,
        },
      }),
    }),
    env,
    nowIso,
    { telegram: client },
  );
  assert.equal(res.status, 200);
}

test('K3: match lists with 0, 1, 8, and 10 matches, day stepping, and match detail + Back to list', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-28T09:00:00Z';

  // Build fixtures:
  // 2026-11-27 (0 matches)
  // 2026-11-28 (1 match with locked close prediction + LIVE status)
  // 2026-11-29 (8 matches -> exactly 1 page)
  // 2026-11-30 (10 matches -> 2 pages: 8 on page 0, 2 on page 1)
  const fixtures: IngestFixture[] = [
    {
      match_id: 'E0:2026:arsenal:chelsea',
      league: 'E0',
      season: 2026,
      home_team: 'arsenal',
      away_team: 'chelsea',
      home_display: 'Arsenal',
      away_display: 'Chelsea',
      kickoff_utc: '2026-11-28T16:30:00Z',
      status: 'NS',
    },
  ];

  for (let i = 1; i <= 8; i++) {
    fixtures.push({
      match_id: `E0:2026:team-a${i}:team-b${i}`,
      league: 'E0',
      season: 2026,
      home_team: `team a${i}`,
      away_team: `team b${i}`,
      home_display: `HomeA${i}`,
      away_display: `AwayB${i}`,
      kickoff_utc: `2026-11-29T1${i}:00:00Z`,
      status: 'NS',
    });
  }

  for (let i = 1; i <= 10; i++) {
    const hh = String(10 + i).padStart(2, '0');
    fixtures.push({
      match_id: `E0:2026:club-x${i}:club-y${i}`,
      league: 'E0',
      season: 2026,
      home_team: `club x${i}`,
      away_team: `club y${i}`,
      home_display: `ClubX${i}`,
      away_display: `ClubY${i}`,
      kickoff_utc: `2026-11-30T${hh}:00:00Z`,
      status: 'NS',
    });
  }

  await ingestData(
    d1,
    {
      model_version: { model_version: 'v1', config_hash: 'h1' },
      fixtures,
      predictions: [
        {
          match_id: 'E0:2026:arsenal:chelsea',
          model_version: 'v1',
          config_hash: 'h1',
          kickoff_utc: '2026-11-28T16:30:00Z',
          p_home: 0.38,
          p_draw: 0.28,
          p_away: 0.34,
          xg_home: 1.45,
          xg_away: 1.31,
          predicted_outcome: 'H',
          summary_reason: 'Very evenly matched sides.',
        },
      ],
    },
    now,
  );

  const rec = makeRecorder();

  // 0 matches day
  await tap(env, 'v1:day:2026-11-27:0', now, rec.client);
  let last = rec.edited[rec.edited.length - 1];
  assert.match(last.text, /No Premier League matches scheduled/);
  let buttons = last.reply_markup!.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'v1:day:2026-11-28:0'));

  // Step to next day -> 1 match (17:30 WAT Arsenal v Chelsea)
  await tap(env, 'v1:day:2026-11-28:0', now, rec.client);
  last = rec.edited[rec.edited.length - 1];
  buttons = last.reply_markup!.inline_keyboard.flat();
  const matchBtn = buttons.find((b) => b.text.includes('17:30 Arsenal v Chelsea'));
  assert.ok(matchBtn, 'Expected "17:30 Arsenal v Chelsea" button');
  assert.ok(!buttons.some((b) => b.text.includes('Next ➡️')));

  // Tap match -> detail view with probabilities, xG, reason, close match, Refresh, Back to list, Home
  await tap(env, matchBtn.callback_data, now, rec.client);
  last = rec.edited[rec.edited.length - 1];
  assert.match(last.text, /Arsenal vs Chelsea/);
  assert.match(last.text, /Home 38% \| Draw 28% \| Away 34%/);
  assert.match(last.text, /Close match, draw risk/);
  assert.match(last.text, /Expected goals: 1\.45 – 1\.31/);
  assert.match(last.text, /Very evenly matched sides/);
  buttons = last.reply_markup!.inline_keyboard.flat();
  const refreshBtn = buttons.find((b) => b.text.includes('Refresh'));
  const backBtn = buttons.find((b) => b.text.includes('Back to list'));
  assert.ok(refreshBtn);
  assert.ok(backBtn);
  assert.ok(buttons.some((b) => b.text.includes('Home')));

  // Tap Back to list -> returns to 2026-11-28 list
  await tap(env, backBtn.callback_data, now, rec.client);
  last = rec.edited[rec.edited.length - 1];
  assert.match(last.text, /2026-11-28 WAT/);

  // 8 matches day -> 8 match buttons, NO pagination row
  await tap(env, 'v1:day:2026-11-29:0', now, rec.client);
  last = rec.edited[rec.edited.length - 1];
  buttons = last.reply_markup!.inline_keyboard.flat();
  const matchButtons8 = buttons.filter((b) => b.callback_data.startsWith('v1:md:'));
  assert.equal(matchButtons8.length, 8);
  assert.ok(!buttons.some((b) => b.text === 'Next ➡️'));

  // 10 matches day -> Page 1 has 8 matches + Next ➡️
  await tap(env, 'v1:day:2026-11-30:0', now, rec.client);
  last = rec.edited[rec.edited.length - 1];
  assert.match(last.text, /Page 1\/2/);
  buttons = last.reply_markup!.inline_keyboard.flat();
  assert.equal(buttons.filter((b) => b.callback_data.startsWith('v1:md:')).length, 8);
  const nextPageBtn = buttons.find((b) => b.text === 'Next ➡️');
  assert.ok(nextPageBtn);

  // Page 2 has 2 matches + ⬅️ Previous
  await tap(env, nextPageBtn.callback_data, now, rec.client);
  last = rec.edited[rec.edited.length - 1];
  assert.match(last.text, /Page 2\/2/);
  buttons = last.reply_markup!.inline_keyboard.flat();
  assert.equal(buttons.filter((b) => b.callback_data.startsWith('v1:md:')).length, 2);
  assert.ok(buttons.some((b) => b.text === '⬅️ Previous'));
});
