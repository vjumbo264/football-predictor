import assert from 'node:assert/strict';
import test from 'node:test';
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

test('K5: persistent quick-access keyboard, button-text routing, and first-time vs returning /start', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const now = '2026-11-27T10:00:00Z';
  const rec = makeRecorder();
  const emptyFetch: typeof fetch = async () => new Response('[]', { status: 200 });

  async function sendMsg(text: string) {
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
            message_id: 10,
            from: { id: 6339561761, first_name: 'Victor' },
            chat: { id: 6339561761, type: 'private' },
            text,
          },
        }),
      }),
      env,
      now,
      { telegram: rec.client, fetchFn: emptyFetch },
    );
    assert.equal(res.status, 200);
  }

  // 1. First-time /start -> pins 4-button persistent reply keyboard AND shows guided intro page 1
  await sendMsg('/start');
  assert.equal(rec.sent.length, 2);
  const rk = rec.sent[0].reply_markup;
  assert.ok(rk && 'keyboard' in rk);
  assert.equal(rk.resize_keyboard, true);
  assert.equal(rk.is_persistent, true);
  assert.equal(rk.keyboard.length, 1);
  assert.deepEqual(
    rk.keyboard[0].map((b) => b.text),
    ['Today', 'Live', 'Results', 'Menu'],
  );

  const intro1 = rec.sent[1];
  assert.match(intro1.text, /Home \/ Draw \/ Away %/);
  assert.match(intro1.text, /Close match, draw risk/);
  assert.match(intro1.text, /lock before kickoff/i);
  assert.ok(intro1.reply_markup && 'inline_keyboard' in intro1.reply_markup);
  const nextBtn = intro1.reply_markup.inline_keyboard.flat().find((b) => b.text.includes('Next'));
  assert.ok(nextBtn);

  // Tap Next ➡️ -> guided intro page 2 (honest accuracy, /performance, disclaimer)
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
          id: 'cq-next',
          from: { id: 6339561761, first_name: 'Victor' },
          message: { message_id: 11, chat: { id: 6339561761, type: 'private' } },
          data: nextBtn.callback_data,
        },
      }),
    }),
    env,
    now,
    { telegram: rec.client },
  );
  assert.equal(rec.edited.length, 1);
  assert.match(rec.edited[0].text, /50–55%/);
  assert.match(rec.edited[0].text, /\/performance/);
  assert.match(rec.edited[0].text, /Betting carries risk/i);

  // 2. Returning /start -> opens Main Menu instead of repeating first-time onboarding
  rec.sent.length = 0;
  await sendMsg('/start');
  assert.equal(rec.sent.length, 2);
  assert.match(rec.sent[1].text, /Main Menu/);

  // 3. Tapping reply keyboard text buttons ("Today", "Live", "Results", "Menu") works like commands
  rec.sent.length = 0;
  await sendMsg('Today');
  assert.match(rec.sent[0].text, /Today's Premier League Matches/);

  await sendMsg('Live');
  assert.match(rec.sent[1].text, /Live Premier League Matches/);

  await sendMsg('Results');
  assert.match(rec.sent[2].text, /Recent Premier League Results/);

  await sendMsg('Menu');
  assert.match(rec.sent[3].text, /Main Menu/);
});
