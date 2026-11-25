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

const ADMIN_ID = 6339561761;
const SECRET_USER_ID = 555000111;
const STRANGER_ID = 999111222;
const DECLINED_ID = 888333444;

function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    INGEST_SECRET: 's',
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_WEBHOOK_SECRET: 'w',
    ALLOWED_TELEGRAM_IDS: String(SECRET_USER_ID),
    ADMIN_TELEGRAM_IDS: String(ADMIN_ID),
    FOOTBALL_API_KEY: 'k',
    API_DAILY_CAP: '80',
    LIVE_CACHE_SECONDS: '60',
    CLOSE_MATCH_GAP: '0.08',
    DEFAULT_LEAGUE: 'E0',
  };
}

function makeRecorder(failChatIds: Set<string> = new Set()) {
  const sent: OutgoingMessage[] = [];
  const edited: EditMessagePayload[] = [];
  const answered: AnswerCallbackPayload[] = [];
  const client: TelegramClient = {
    async sendMessage(m) {
      if (failChatIds.has(String(m.chat_id))) {
        throw new Error('Forbidden: bot cannot initiate conversation with a user');
      }
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

async function postMessage(
  env: Env,
  fromId: number,
  text: string,
  nowIso: string,
  client: TelegramClient,
  firstName = 'TestUser',
  username?: string,
) {
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
          from: { id: fromId, first_name: firstName, username },
          chat: { id: fromId, type: 'private' },
          text,
        },
      }),
    }),
    env,
    nowIso,
    { telegram: client },
  );
  assert.equal(res.status, 200);
  return (await res.json()) as any;
}

async function postCallback(
  env: Env,
  fromId: number,
  data: string,
  nowIso: string,
  client: TelegramClient,
  messageId = 200,
) {
  const res = await handleRequest(
    new Request('https://worker.test/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 2,
        callback_query: {
          id: `cq-${fromId}-${data}`,
          from: { id: fromId, first_name: 'Caller' },
          message: { message_id: messageId, chat: { id: fromId, type: 'private' } },
          data,
        },
      }),
    }),
    env,
    nowIso,
    { telegram: client },
  );
  assert.equal(res.status, 200);
  return (await res.json()) as any;
}

test('K6: approval flow, 24h anti-spam, forged callback rejection, decline silencing, /pending, /users, /adduser, /removeuser, and secret allowlist', async () => {
  const { d1 } = createTestDb();
  const env = makeEnv(d1);
  const t0 = '2026-11-27T10:00:00Z';
  const rec = makeRecorder();

  // 1. Original ALLOWED_TELEGRAM_IDS secret user still works (even without being in ADMIN_TELEGRAM_IDS or allowed_users table)
  const secretRes = await postMessage(env, SECRET_USER_ID, '/menu', t0, rec.client, 'Friend');
  assert.equal(secretRes.allowed, true);
  assert.match(rec.sent[0].text, /Main Menu/);

  // 2. Non-admin allowed user CANNOT run admin commands or press forged Approve/Decline buttons
  rec.sent.length = 0;
  for (const cmd of ['/pending', '/users', `/adduser ${STRANGER_ID}`, `/removeuser ${STRANGER_ID}`]) {
    const r = await postMessage(env, SECRET_USER_ID, cmd, t0, rec.client, 'Friend');
    assert.equal(r.allowed, false);
  }
  assert.equal(rec.sent.length, 4);
  for (const m of rec.sent) {
    assert.match(m.text, /restricted to bot admins/i);
  }

  // Forged admin callback by non-admin (both secret user and unapproved stranger)
  for (const badActor of [SECRET_USER_ID, STRANGER_ID]) {
    rec.answered.length = 0;
    rec.edited.length = 0;
    const forged = await postCallback(env, badActor, `v1:adm:app:${STRANGER_ID}`, t0, rec.client);
    assert.equal(forged.allowed, false);
    assert.equal(rec.answered[0].show_alert, true);
    assert.equal(rec.edited.length, 0);
  }
  const allowedRowBefore = await d1
    .prepare('SELECT 1 AS ok FROM allowed_users WHERE telegram_id = ?')
    .bind(String(STRANGER_ID))
    .first();
  assert.equal(allowedRowBefore, null);

  // 3. Unapproved user's first message -> 1 user message + 1 admin notification with Approve/Decline buttons
  rec.sent.length = 0;
  const firstMsg = await postMessage(env, STRANGER_ID, '/today', t0, rec.client, 'Chidi', 'chidi_pl');
  assert.equal(firstMsg.allowed, false);
  assert.equal(rec.sent.length, 2);
  assert.equal(rec.sent[0].chat_id, STRANGER_ID);
  assert.match(rec.sent[0].text, /private/i);

  const adminNotif = rec.sent[1];
  assert.equal(adminNotif.chat_id, String(ADMIN_ID));
  assert.match(adminNotif.text, /Chidi/);
  assert.match(adminNotif.text, /@chidi_pl/);
  assert.match(adminNotif.text, new RegExp(String(STRANGER_ID)));
  assert.ok(adminNotif.reply_markup && 'inline_keyboard' in adminNotif.reply_markup);
  const approveBtn = adminNotif.reply_markup.inline_keyboard.flat().find((b) => b.text.includes('Approve'));
  const declineBtn = adminNotif.reply_markup.inline_keyboard.flat().find((b) => b.text.includes('Decline'));
  assert.ok(approveBtn && declineBtn);

  // 4. Repeated messages from same unapproved user within 24h -> NO replies, NO duplicate admin notifications
  rec.sent.length = 0;
  await postMessage(env, STRANGER_ID, '/live', '2026-11-27T12:00:00Z', rec.client, 'Chidi', 'chidi_pl');
  await postMessage(env, STRANGER_ID, 'hello?', '2026-11-27T18:00:00Z', rec.client, 'Chidi', 'chidi_pl');
  assert.equal(rec.sent.length, 0);

  // After 24h -> 1 reminder to user, still NO duplicate admin notification
  await postMessage(env, STRANGER_ID, '/today', '2026-11-28T11:00:00Z', rec.client, 'Chidi', 'chidi_pl');
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0].chat_id, STRANGER_ID);

  // 5. Admin taps Approve -> adds to allowed_users, edits admin message to "Approved", notifies user with quick keyboard + home menu
  rec.sent.length = 0;
  rec.edited.length = 0;
  await postCallback(env, ADMIN_ID, approveBtn.callback_data, '2026-11-28T11:05:00Z', rec.client);
  assert.equal(rec.edited.length, 1);
  assert.match(rec.edited[0].text, /Approved/);
  assert.equal(rec.sent.length, 2);
  assert.equal(rec.sent[0].chat_id, String(STRANGER_ID));
  assert.ok(rec.sent[0].reply_markup && 'keyboard' in rec.sent[0].reply_markup);
  assert.equal(rec.sent[1].chat_id, String(STRANGER_ID));
  assert.ok(rec.sent[1].reply_markup && 'inline_keyboard' in rec.sent[1].reply_markup);
  assert.match(rec.sent[1].text, /Main Menu/);

  // Approved user immediately has access
  rec.sent.length = 0;
  const nowAllowed = await postMessage(env, STRANGER_ID, '/today', '2026-11-28T11:06:00Z', rec.client);
  assert.equal(nowAllowed.allowed, true);
  assert.match(rec.sent[0].text, /Today's Premier League Matches/);

  // 6. Admin /users lists approved users with Remove button; tapping Remove removes user
  rec.sent.length = 0;
  await postMessage(env, ADMIN_ID, '/users', '2026-11-28T11:10:00Z', rec.client);
  assert.match(rec.sent[0].text, new RegExp(String(STRANGER_ID)));
  const remBtn = (rec.sent[0].reply_markup as any).inline_keyboard.flat().find((b: any) =>
    b.callback_data === `v1:adm:rem:${STRANGER_ID}`,
  );
  assert.ok(remBtn);

  rec.edited.length = 0;
  await postCallback(env, ADMIN_ID, remBtn.callback_data, '2026-11-28T11:11:00Z', rec.client);
  assert.match(rec.edited[0].text, /Removed/);

  // Removed user is treated as a brand-new unapproved user if they message again
  rec.sent.length = 0;
  const afterRem = await postMessage(env, STRANGER_ID, '/today', '2026-11-28T11:12:00Z', rec.client, 'Chidi');
  assert.equal(afterRem.allowed, false);
  assert.equal(rec.sent.length, 2); // user message + fresh admin notification

  // 7. Admin taps Decline -> edits admin message to "Declined", silently ignores declined user afterwards
  rec.sent.length = 0;
  await postMessage(env, DECLINED_ID, '/start', '2026-11-28T12:00:00Z', rec.client, 'Spammer');
  assert.equal(rec.sent.length, 2);
  const decBtn = (rec.sent[1].reply_markup as any).inline_keyboard.flat().find((b: any) => b.text.includes('Decline'));
  rec.sent.length = 0;
  rec.edited.length = 0;
  await postCallback(env, ADMIN_ID, decBtn.callback_data, '2026-11-28T12:01:00Z', rec.client);
  assert.match(rec.edited[0].text, /Declined/);
  assert.equal(rec.sent.length, 0); // declined user not notified

  // Subsequent message from declined user (even >24h later) is silently ignored
  await postMessage(env, DECLINED_ID, '/start', '2026-11-30T12:00:00Z', rec.client, 'Spammer');
  assert.equal(rec.sent.length, 0);

  // 8. Admin /pending lists waiting requests even if admin notification previously failed to deliver
  const { d1: d1b } = createTestDb();
  const envB = makeEnv(d1b);
  const failingRec = makeRecorder(new Set([String(ADMIN_ID)]));
  await postMessage(envB, 444555666, '/start', t0, failingRec.client, 'Amina', 'amina_ng');
  // User got notified; admin notification threw, but request was persisted in D1
  assert.equal(failingRec.sent.length, 1);

  const adminRec = makeRecorder();
  await postMessage(envB, ADMIN_ID, '/pending', t0, adminRec.client, 'Victor');
  assert.match(adminRec.sent[0].text, /Amina/);
  assert.match(adminRec.sent[0].text, /444555666/);

  // /adduser and /removeuser commands work directly
  adminRec.sent.length = 0;
  await postMessage(envB, ADMIN_ID, '/adduser 777000999', t0, adminRec.client, 'Victor');
  assert.match(adminRec.sent[adminRec.sent.length - 1].text, /Added user/);
  adminRec.sent.length = 0;
  await postMessage(envB, ADMIN_ID, '/removeuser 777000999', t0, adminRec.client, 'Victor');
  assert.match(adminRec.sent[0].text, /Removed user/);
});
