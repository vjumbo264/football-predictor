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
import type { Env } from '../src/types';
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

test('K4: 20-team alphabetical 3-per-row grid, team with fixture, team without upcoming fixture, and typed plain-text path', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-27T10:00:00Z';

  await ingestData(
    d1,
    {
      model_version: { model_version: 'v1', config_hash: 'h1' },
      fixtures: [
        // Past result for Arsenal & Sunderland
        {
          match_id: 'E0:2026:arsenal:sunderland',
          league: 'E0',
          season: 2026,
          home_team: 'arsenal',
          away_team: 'sunderland',
          home_display: 'Arsenal',
          away_display: 'Sunderland',
          kickoff_utc: '2026-11-10T15:00:00Z',
          status: 'FT',
        },
        // Upcoming fixture for Arsenal (no upcoming fixture for Sunderland)
        {
          match_id: 'E0:2026:arsenal:chelsea',
          league: 'E0',
          season: 2026,
          home_team: 'arsenal',
          away_team: 'chelsea',
          home_display: 'Arsenal',
          away_display: 'Chelsea',
          kickoff_utc: '2026-11-27T20:00:00Z',
          status: 'NS',
        },
      ],
      results: [
        {
          match_id: 'E0:2026:arsenal:sunderland',
          home_goals: 3,
          away_goals: 1,
          actual_outcome: 'H',
          source: 'fpl',
        },
      ],
      predictions: [
        {
          match_id: 'E0:2026:arsenal:chelsea',
          model_version: 'v1',
          config_hash: 'h1',
          kickoff_utc: '2026-11-27T20:00:00Z',
          p_home: 0.52,
          p_draw: 0.25,
          p_away: 0.23,
          xg_home: 1.75,
          xg_away: 1.05,
          predicted_outcome: 'H',
          summary_reason: 'Strong home attack.',
        },
      ],
    },
    now,
  );

  const rec = makeRecorder();

  // 1. Open Find a match grid
  await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1,
        callback_query: {
          id: 'cq-teams',
          from: { id: 6339561761, first_name: 'Victor' },
          message: { message_id: 5, chat: { id: 6339561761, type: 'private' } },
          data: 'v1:teams',
        },
      }),
    }),
    env,
    now,
    { telegram: rec.client },
  );

  const gridKb = rec.edited[0].reply_markup!.inline_keyboard;
  // First 6 rows have 3 teams, 7th row has 2 teams = 20 teams; 8th row is Back + Home
  assert.equal(gridKb.length, 8);
  for (let r = 0; r < 6; r++) assert.equal(gridKb[r].length, 3);
  assert.equal(gridKb[6].length, 2);

  const teamButtons = gridKb.slice(0, 7).flat();
  assert.equal(teamButtons.length, 20);
  const codes = teamButtons.map((b) => b.text);
  const sortedCodes = [...codes].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(codes, sortedCodes);

  // 2. Tap Arsenal (ARS) -> shows next fixture + prediction + last 5 results + Back + Home
  await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 2,
        callback_query: {
          id: 'cq-ars',
          from: { id: 6339561761, first_name: 'Victor' },
          message: { message_id: 5, chat: { id: 6339561761, type: 'private' } },
          data: 'v1:t:ARS',
        },
      }),
    }),
    env,
    now,
    { telegram: rec.client },
  );
  const arsScreen = rec.edited[1];
  assert.match(arsScreen.text, /Arsenal vs Chelsea/);
  assert.match(arsScreen.text, /Home 52% \| Draw 25% \| Away 23%/);
  assert.match(arsScreen.text, /W 3-1 vs Sunderland/);
  assert.ok(arsScreen.reply_markup!.inline_keyboard.flat().some((b) => b.callback_data === 'v1:teams'));
  assert.ok(arsScreen.reply_markup!.inline_keyboard.flat().some((b) => b.callback_data === 'v1:home'));

  // 3. Tap Sunderland (SUN) -> no upcoming fixture, still shows last 5 results + Back + Home
  await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 3,
        callback_query: {
          id: 'cq-sun',
          from: { id: 6339561761, first_name: 'Victor' },
          message: { message_id: 5, chat: { id: 6339561761, type: 'private' } },
          data: 'v1:t:SUN',
        },
      }),
    }),
    env,
    now,
    { telegram: rec.client },
  );
  const sunScreen = rec.edited[2];
  assert.match(sunScreen.text, /No upcoming Premier League fixture scheduled/);
  assert.match(sunScreen.text, /L 1-3 vs Arsenal/);

  // 4. Plain-text team alias ("gunners") and /match alias ("/match blues") both still work
  for (const text of ['gunners', '/match blues']) {
    await handleRequest(
      new Request('https://worker.test/telegram/webhook', {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          update_id: 4,
          message: {
            message_id: 12,
            from: { id: 6339561761, first_name: 'Victor' },
            chat: { id: 6339561761, type: 'private' },
            text,
          },
        }),
      }),
      env,
      now,
      { telegram: rec.client },
    );
  }
  assert.equal(rec.sent.length, 2);
  assert.match(rec.sent[0].text, /Arsenal vs Chelsea/);
  assert.match(rec.sent[1].text, /Arsenal vs Chelsea/);
});
