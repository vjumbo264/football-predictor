import {
  approveUserById,
  buildPendingScreen,
  buildUsersScreen,
  declineUserById,
  handleUnapprovedMessage,
  removeUserById,
  type AdminTelegramBridge,
} from './admin';
import { isAdminUser, isUserAllowed } from './auth';
import {
  addDaysDateStr,
  buildDayView,
  buildMatchDetailView,
  buildMatchQueryView,
  buildTeamView,
  buildTeamsGridView,
  lagosDateStr,
} from './commands_schedule';
import type {
  Env,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  RenderedScreen,
  ReplyKeyboardMarkup,
  ReplyMarkup,
} from './types';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface OutgoingMessage {
  chat_id: string | number;
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: boolean;
  reply_markup?: ReplyMarkup;
}

export interface EditMessagePayload {
  chat_id: string | number;
  message_id: number;
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: boolean;
  reply_markup?: InlineKeyboardMarkup;
}

export interface EditMessageResult {
  ok: boolean;
  fallbackToSend?: boolean;
  reason?: string;
}

export interface AnswerCallbackPayload {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface TelegramClient {
  sendMessage: (msg: OutgoingMessage) => Promise<void>;
  editMessageText: (msg: EditMessagePayload) => Promise<EditMessageResult>;
  answerCallbackQuery: (payload: AnswerCallbackPayload) => Promise<void>;
}

export type TelegramSender = (msg: OutgoingMessage) => Promise<void>;

export const QUICK_REPLY_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: 'Today' }, { text: 'Live' }, { text: 'Results' }, { text: 'Menu' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function createTelegramSender(botToken: string): TelegramSender {
  return async (msg: OutgoingMessage) => {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Telegram sendMessage HTTP ${res.status}: ${detail}`);
    }
  };
}

function isRecoverableEditError(description: string): boolean {
  const d = description.toLowerCase();
  return (
    d.includes('message is not modified') ||
    d.includes('message to edit not found') ||
    d.includes("message can't be edited") ||
    d.includes('message_id_invalid') ||
    d.includes('too old')
  );
}

export function createTelegramClient(botToken: string, fetchFn: typeof fetch = fetch): TelegramClient {
  return {
    async sendMessage(msg: OutgoingMessage) {
      const res = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Telegram sendMessage HTTP ${res.status}: ${detail}`);
      }
    },
    async editMessageText(msg: EditMessagePayload): Promise<EditMessageResult> {
      const res = await fetchFn(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (res.ok) {
        return { ok: true };
      }
      const raw = await res.text();
      let description = raw;
      try {
        const parsed = JSON.parse(raw) as { description?: string };
        if (parsed.description) description = parsed.description;
      } catch {
        // raw text fallback
      }
      if (res.status === 400 && isRecoverableEditError(description)) {
        return { ok: false, fallbackToSend: true, reason: description };
      }
      throw new Error(`Telegram editMessageText HTTP ${res.status}: ${description}`);
    },
    async answerCallbackQuery(payload: AnswerCallbackPayload) {
      const res = await fetchFn(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const raw = await res.text();
        if (res.status === 400 && raw.toLowerCase().includes('query is too old')) {
          return;
        }
        throw new Error(`Telegram answerCallbackQuery HTTP ${res.status}: ${raw}`);
      }
    },
  };
}

export function wrapSenderAsClient(sender: TelegramSender): TelegramClient {
  return {
    sendMessage: sender,
    async editMessageText(msg: EditMessagePayload): Promise<EditMessageResult> {
      await sender({
        chat_id: msg.chat_id,
        text: msg.text,
        parse_mode: msg.parse_mode,
        disable_web_page_preview: msg.disable_web_page_preview,
        reply_markup: msg.reply_markup,
      });
      return { ok: true };
    },
    async answerCallbackQuery() {
      // no-op for legacy sender-only test hooks
    },
  };
}

export function buildHomeScreen(nowIso: string): RenderedScreen {
  const todayWat = lagosDateStr(nowIso);
  const tomorrowWat = addDaysDateStr(todayWat, 1);
  return {
    text: [
      '<b>Football Predictor — Main Menu</b>',
      'Honest Premier League win, draw, and loss probabilities.',
      '<i>Statistical estimates only (~50–55% typical accuracy). Not guarantees.</i>',
      '',
      'Tap an option below:',
    ].join('\n'),
    inline_keyboard: [
      [
        { text: '📅 Today', callback_data: `v1:day:${todayWat}:0` },
        { text: '📆 Tomorrow', callback_data: `v1:day:${tomorrowWat}:0` },
      ],
      [
        { text: '🔴 Live', callback_data: 'v1:live' },
        { text: '✅ Results', callback_data: 'v1:res' },
      ],
      [
        { text: '📊 Performance', callback_data: 'v1:perf' },
        { text: '🔍 Find a match', callback_data: 'v1:teams' },
      ],
      [{ text: '❓ How to use', callback_data: 'v1:help:0' }],
    ],
  };
}

export function buildHelpScreen(page: 0 | 1 = 0): RenderedScreen {
  if (page === 0) {
    return {
      text: [
        '<b>Welcome to Football Predictor</b>',
        'Honest Premier League match probabilities — no tips, no hype.',
        '',
        '• <b>Home / Draw / Away %</b> = our estimated chance of each result.',
        '• <b>⚖️ Close match, draw risk</b> = the top two outcomes are close, so a draw or upset is more likely.',
        '• Predictions <b>lock before kickoff</b> and are never edited afterwards.',
      ].join('\n'),
      inline_keyboard: [
        [{ text: 'Next ➡️', callback_data: 'v1:help:1' }],
        [
          { text: '⬅️ Back', callback_data: 'v1:home' },
          { text: '🏠 Home', callback_data: 'v1:home' },
        ],
      ],
    };
  }

  return {
    text: [
      '<b>Track record &amp; honest limits</b>',
      '',
      '• Top-flight football is hard to call — even good models get roughly <b>50–55%</b> of results right, and draws are rarely the top pick.',
      '• Tap <b>Performance</b> (<code>/performance</code>) anytime for our real settled accuracy.',
      '• Use the buttons below or at the bottom (<b>Today</b>, <b>Live</b>, <b>Results</b>, <b>Menu</b>) — no typing needed.',
      '',
      '<i>Statistical estimates only, not guarantees. Betting carries risk.</i>',
    ].join('\n'),
    inline_keyboard: [
      [
        { text: '⬅️ Back', callback_data: 'v1:help:0' },
        { text: '🏠 Home', callback_data: 'v1:home' },
      ],
    ],
  };
}

export function formatStartHelp(): string {
  return `${buildHelpScreen(0).text}\n\n${buildHelpScreen(1).text}`;
}

export interface CommandDependencies {
  onToday?: (env: Env, nowIso: string) => Promise<string>;
  onTomorrow?: (env: Env, nowIso: string) => Promise<string>;
  onMatch?: (env: Env, query: string, nowIso: string) => Promise<string>;
  onLive?: (env: Env, nowIso: string) => Promise<string>;
  onResults?: (env: Env, nowIso: string) => Promise<string>;
  onPerformance?: (env: Env, nowIso: string) => Promise<string>;
}

async function recordUser(
  db: D1Database,
  user: TelegramUser | undefined,
  chatId: number,
  isAllowed: boolean,
  nowIso: string,
): Promise<{ onboarded_at: string | null }> {
  const telegramId = String(user?.id ?? chatId);
  await db
    .prepare(
      `INSERT INTO users (telegram_id, username, first_name, is_allowed, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = COALESCE(excluded.username, users.username),
                     first_name = COALESCE(excluded.first_name, users.first_name),
                     is_allowed = excluded.is_allowed,
                     last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      telegramId,
      user?.username ?? null,
      user?.first_name ?? null,
      isAllowed ? 1 : 0,
      nowIso,
    )
    .run();

  const row = await db
    .prepare('SELECT onboarded_at FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ onboarded_at: string | null }>();
  return { onboarded_at: row?.onboarded_at ?? null };
}

function makeAdminBridge(client: TelegramClient): AdminTelegramBridge {
  return {
    sendMessage: (m) => client.sendMessage(m as OutgoingMessage),
    editMessageText: async (m) => {
      const res = await client.editMessageText(m);
      if (!res.ok && res.fallbackToSend) {
        await client.sendMessage({
          chat_id: m.chat_id,
          text: m.text,
          parse_mode: m.parse_mode,
          disable_web_page_preview: m.disable_web_page_preview,
          reply_markup: m.reply_markup,
        });
      }
    },
    answerCallbackQuery: (p) => client.answerCallbackQuery(p),
  };
}

async function sendScreen(
  client: TelegramClient,
  chatId: string | number,
  screen: RenderedScreen,
): Promise<void> {
  await client.sendMessage({
    chat_id: chatId,
    text: screen.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: screen.inline_keyboard ? { inline_keyboard: screen.inline_keyboard } : undefined,
  });
}

async function editOrSendScreen(
  client: TelegramClient,
  chatId: string | number,
  messageId: number | undefined,
  screen: RenderedScreen,
): Promise<void> {
  const markup: InlineKeyboardMarkup | undefined = screen.inline_keyboard
    ? { inline_keyboard: screen.inline_keyboard }
    : undefined;
  if (messageId !== undefined) {
    const res = await client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: screen.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: markup,
    });
    if (res.ok || !res.fallbackToSend) {
      return;
    }
  }
  await client.sendMessage({
    chat_id: chatId,
    text: screen.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: markup,
  });
}

function navButtons(refreshCallback: string): InlineKeyboardButton[][] {
  return [
    [{ text: '🔄 Refresh', callback_data: refreshCallback }],
    [
      { text: '⬅️ Back', callback_data: 'v1:home' },
      { text: '🏠 Home', callback_data: 'v1:home' },
    ],
  ];
}

async function renderScreenForCallback(
  data: string,
  env: Env,
  deps: CommandDependencies,
  nowIso: string,
): Promise<RenderedScreen> {
  if (data === 'v1:home') {
    return buildHomeScreen(nowIso);
  }
  if (data === 'v1:live') {
    const text = deps.onLive ? await deps.onLive(env, nowIso) : 'Live view not wired yet.';
    return { text, inline_keyboard: navButtons('v1:live') };
  }
  if (data === 'v1:res') {
    const text = deps.onResults ? await deps.onResults(env, nowIso) : 'Results view not wired yet.';
    return { text, inline_keyboard: navButtons('v1:res') };
  }
  if (data === 'v1:perf') {
    const text = deps.onPerformance
      ? await deps.onPerformance(env, nowIso)
      : 'Performance view not wired yet.';
    return { text, inline_keyboard: navButtons('v1:perf') };
  }
  if (data === 'v1:teams') {
    return buildTeamsGridView();
  }
  if (data.startsWith('v1:t:')) {
    const code = data.slice('v1:t:'.length);
    return buildTeamView(env, code, nowIso);
  }
  if (data === 'v1:help:0') {
    return buildHelpScreen(0);
  }
  if (data === 'v1:help:1') {
    return buildHelpScreen(1);
  }

  const dayMatch = /^v1:day:(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(data);
  if (dayMatch) {
    return buildDayView(env, dayMatch[1], Number(dayMatch[2]), nowIso);
  }

  const mdMatch = /^v1:md:(\d+):(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(data);
  if (mdMatch) {
    const rowId = Number(mdMatch[1]);
    const dateStr = mdMatch[2];
    const page = Number(mdMatch[3]);
    return buildMatchDetailView(env, rowId, `v1:day:${dateStr}:${page}`, data, nowIso);
  }

  const mtMatch = /^v1:mt:(\d+):([A-Za-z0-9_ -]+)$/.exec(data);
  if (mtMatch) {
    const rowId = Number(mtMatch[1]);
    const teamCode = mtMatch[2];
    return buildMatchDetailView(env, rowId, `v1:t:${teamCode}`, data, nowIso);
  }

  return buildHomeScreen(nowIso);
}

async function handleCallbackQuery(
  cq: TelegramCallbackQuery,
  env: Env,
  client: TelegramClient,
  deps: CommandDependencies,
  nowIso: string,
): Promise<{ handled: boolean; allowed: boolean; command?: string }> {
  const callerId = String(cq.from.id);
  const data = (cq.data ?? '').trim();
  const chatId = cq.message?.chat?.id ?? cq.from.id;
  const messageId = cq.message?.message_id;

  // Admin callbacks require ADMIN_TELEGRAM_IDS regardless of user allowlist
  if (data.startsWith('v1:adm:')) {
    if (!isAdminUser(env, callerId)) {
      await client.answerCallbackQuery({
        callback_query_id: cq.id,
        text: 'Not authorized.',
        show_alert: true,
      });
      return { handled: true, allowed: false, command: data };
    }

    const bridge = makeAdminBridge(client);

    if (data === 'v1:adm:pend') {
      await client.answerCallbackQuery({ callback_query_id: cq.id });
      await editOrSendScreen(client, chatId, messageId, await buildPendingScreen(env));
      return { handled: true, allowed: true, command: data };
    }

    if (data === 'v1:adm:users') {
      await client.answerCallbackQuery({ callback_query_id: cq.id });
      await editOrSendScreen(client, chatId, messageId, await buildUsersScreen(env));
      return { handled: true, allowed: true, command: data };
    }

    const appMatch = /^v1:adm:app:(\d+)$/.exec(data);
    if (appMatch) {
      const targetId = appMatch[1];
      const info = await approveUserById(env, targetId, callerId, nowIso);
      const label = [info.first_name, info.username ? `@${info.username}` : null]
        .filter(Boolean)
        .join(' ');
      const pending = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM access_requests WHERE status = 'pending'")
        .first<{ c: number }>();
      const kb: InlineKeyboardButton[][] =
        (pending?.c ?? 0) > 0
          ? [[{ text: '📋 View pending', callback_data: 'v1:adm:pend' }]]
          : [];
      await client.answerCallbackQuery({ callback_query_id: cq.id, text: 'Approved' });
      await editOrSendScreen(client, chatId, messageId, {
        text: `✅ <b>Approved</b>${label ? ` — ${escapeHtml(label)}` : ''} (<code>${escapeHtml(targetId)}</code>)`,
        inline_keyboard: kb,
      });

      // Notify approved user with quick keyboard and home menu
      try {
        await client.sendMessage({
          chat_id: targetId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          text: '✅ <b>You are approved!</b> Quick buttons are pinned below.',
          reply_markup: QUICK_REPLY_KEYBOARD,
        });
        await sendScreen(client, targetId, buildHomeScreen(nowIso));
      } catch {
        // User may have blocked bot; approval is still recorded in D1.
      }
      return { handled: true, allowed: true, command: data };
    }

    const decMatch = /^v1:adm:dec:(\d+)$/.exec(data);
    if (decMatch) {
      const targetId = decMatch[1];
      const info = await declineUserById(env, targetId, callerId, nowIso);
      const label = [info.first_name, info.username ? `@${info.username}` : null]
        .filter(Boolean)
        .join(' ');
      const pending = await env.DB
        .prepare("SELECT COUNT(*) AS c FROM access_requests WHERE status = 'pending'")
        .first<{ c: number }>();
      const kb: InlineKeyboardButton[][] =
        (pending?.c ?? 0) > 0
          ? [[{ text: '📋 View pending', callback_data: 'v1:adm:pend' }]]
          : [];
      await client.answerCallbackQuery({ callback_query_id: cq.id, text: 'Declined' });
      await editOrSendScreen(client, chatId, messageId, {
        text: `❌ <b>Declined</b>${label ? ` — ${escapeHtml(label)}` : ''} (<code>${escapeHtml(targetId)}</code>)`,
        inline_keyboard: kb,
      });
      return { handled: true, allowed: true, command: data };
    }

    const remMatch = /^v1:adm:rem:(\d+)$/.exec(data);
    if (remMatch) {
      const targetId = remMatch[1];
      const remRes = await removeUserById(env, targetId);
      await client.answerCallbackQuery({ callback_query_id: cq.id, text: 'Updated' });
      const usersScreen = await buildUsersScreen(env);
      await editOrSendScreen(client, chatId, messageId, {
        text: `${remRes.message}\n\n${usersScreen.text}`,
        inline_keyboard: usersScreen.inline_keyboard,
      });
      return { handled: true, allowed: true, command: data };
    }

    void bridge;
    await client.answerCallbackQuery({ callback_query_id: cq.id });
    return { handled: true, allowed: true, command: data };
  }

  // Non-admin / standard bot callbacks: ignore taps from non-allowed users
  const allowed = await isUserAllowed(env, callerId);
  if (!allowed) {
    await client.answerCallbackQuery({
      callback_query_id: cq.id,
      text: 'Private bot — access required.',
      show_alert: false,
    });
    return { handled: true, allowed: false, command: data };
  }

  await recordUser(env.DB, cq.from, Number(chatId), true, nowIso);
  await client.answerCallbackQuery({ callback_query_id: cq.id });

  const screen = await renderScreenForCallback(data, env, deps, nowIso);
  await editOrSendScreen(client, chatId, messageId, screen);
  return { handled: true, allowed: true, command: data };
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  env: Env,
  senderOrClient: TelegramSender | TelegramClient,
  deps: CommandDependencies = {},
  nowIso: string = new Date().toISOString(),
): Promise<{ handled: boolean; allowed: boolean; command?: string }> {
  const client: TelegramClient =
    typeof senderOrClient === 'function' ? wrapSenderAsClient(senderOrClient) : senderOrClient;

  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query, env, client, deps, nowIso);
  }

  const message = update.message ?? update.edited_message;
  if (!message || !message.chat) {
    return { handled: false, allowed: false };
  }

  const userId = String(message.from?.id ?? message.chat.id);
  const isAllowed = await isUserAllowed(env, userId);
  const userState = await recordUser(env.DB, message.from, message.chat.id, isAllowed, nowIso);

  if (!isAllowed) {
    await handleUnapprovedMessage(env, message.from, message.chat.id, nowIso, makeAdminBridge(client));
    return { handled: true, allowed: false };
  }

  const rawText = (message.text ?? '').trim();
  if (!rawText) {
    await sendScreen(client, message.chat.id, buildHomeScreen(nowIso));
    return { handled: true, allowed: true, command: '/menu' };
  }

  // Map persistent quick-access reply keyboard buttons to commands
  const quickAlias: Record<string, string> = {
    today: '/today',
    live: '/live',
    results: '/results',
    menu: '/menu',
  };
  const normalizedLower = rawText.toLowerCase();
  const effectiveText = quickAlias[normalizedLower] ?? rawText;

  // Plain-text team search (K4): if it doesn't start with '/', treat as team/match query
  if (!effectiveText.startsWith('/')) {
    const screen = await buildMatchQueryView(env, effectiveText, nowIso);
    await sendScreen(client, message.chat.id, screen);
    return { handled: true, allowed: true, command: '/match' };
  }

  const [head, ...rest] = effectiveText.split(/\s+/);
  const cmd = head.toLowerCase().split('@')[0];
  const arg = rest.join(' ').trim();

  // Admin commands (K6)
  if (['/adduser', '/removeuser', '/users', '/pending'].includes(cmd)) {
    if (!isAdminUser(env, userId)) {
      await sendScreen(client, message.chat.id, {
        text: '⛔ This command is restricted to bot admins.',
        inline_keyboard: [[{ text: '🏠 Home', callback_data: 'v1:home' }]],
      });
      return { handled: true, allowed: false, command: cmd };
    }

    if (cmd === '/pending') {
      await sendScreen(client, message.chat.id, await buildPendingScreen(env));
      return { handled: true, allowed: true, command: cmd };
    }

    if (cmd === '/users') {
      await sendScreen(client, message.chat.id, await buildUsersScreen(env));
      return { handled: true, allowed: true, command: cmd };
    }

    if (cmd === '/adduser') {
      if (!/^\d+$/.test(arg)) {
        await sendScreen(client, message.chat.id, {
          text: 'Usage: <code>/adduser &lt;numeric_telegram_id&gt;</code>',
          inline_keyboard: [[{ text: '🏠 Home', callback_data: 'v1:home' }]],
        });
        return { handled: true, allowed: true, command: cmd };
      }
      await approveUserById(env, arg, userId, nowIso);
      try {
        await client.sendMessage({
          chat_id: arg,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          text: '✅ <b>You have been granted access!</b> Quick buttons are pinned below.',
          reply_markup: QUICK_REPLY_KEYBOARD,
        });
        await sendScreen(client, arg, buildHomeScreen(nowIso));
      } catch {
        // User may not have started chat yet.
      }
      await sendScreen(client, message.chat.id, {
        text: `✅ Added user <code>${escapeHtml(arg)}</code> to allowed users.`,
        inline_keyboard: [
          [
            { text: '👥 All users', callback_data: 'v1:adm:users' },
            { text: '🏠 Home', callback_data: 'v1:home' },
          ],
        ],
      });
      return { handled: true, allowed: true, command: cmd };
    }

    if (cmd === '/removeuser') {
      if (!/^\d+$/.test(arg)) {
        await sendScreen(client, message.chat.id, {
          text: 'Usage: <code>/removeuser &lt;numeric_telegram_id&gt;</code>',
          inline_keyboard: [[{ text: '🏠 Home', callback_data: 'v1:home' }]],
        });
        return { handled: true, allowed: true, command: cmd };
      }
      const rem = await removeUserById(env, arg);
      await sendScreen(client, message.chat.id, {
        text: rem.message,
        inline_keyboard: [
          [
            { text: '👥 All users', callback_data: 'v1:adm:users' },
            { text: '🏠 Home', callback_data: 'v1:home' },
          ],
        ],
      });
      return { handled: true, allowed: true, command: cmd };
    }
  }

  switch (cmd) {
    case '/start': {
      const isFirstTime = !userState.onboarded_at;
      if (isFirstTime) {
        await env.DB
          .prepare('UPDATE users SET onboarded_at = ? WHERE telegram_id = ?')
          .bind(nowIso, userId)
          .run();
      }
      await client.sendMessage({
        chat_id: message.chat.id,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: '⚽ <b>Football Predictor</b> — quick buttons ready below.',
        reply_markup: QUICK_REPLY_KEYBOARD,
      });
      await sendScreen(
        client,
        message.chat.id,
        isFirstTime ? buildHelpScreen(0) : buildHomeScreen(nowIso),
      );
      break;
    }
    case '/menu':
      await sendScreen(client, message.chat.id, buildHomeScreen(nowIso));
      break;
    case '/help':
      await sendScreen(client, message.chat.id, buildHelpScreen(0));
      break;
    case '/today': {
      if (deps.onToday) {
        const todayWat = lagosDateStr(nowIso);
        const view = await buildDayView(env, todayWat, 0, nowIso);
        const text = await deps.onToday(env, nowIso);
        await sendScreen(client, message.chat.id, { text, inline_keyboard: view.inline_keyboard });
      } else {
        const todayWat = lagosDateStr(nowIso);
        await sendScreen(client, message.chat.id, await buildDayView(env, todayWat, 0, nowIso));
      }
      break;
    }
    case '/tomorrow': {
      const tomorrowWat = addDaysDateStr(lagosDateStr(nowIso), 1);
      if (deps.onTomorrow) {
        const view = await buildDayView(env, tomorrowWat, 0, nowIso);
        const text = await deps.onTomorrow(env, nowIso);
        await sendScreen(client, message.chat.id, { text, inline_keyboard: view.inline_keyboard });
      } else {
        await sendScreen(client, message.chat.id, await buildDayView(env, tomorrowWat, 0, nowIso));
      }
      break;
    }
    case '/match': {
      if (arg && deps.onMatch) {
        const screen = await buildMatchQueryView(env, arg, nowIso);
        const text = await deps.onMatch(env, arg, nowIso);
        await sendScreen(client, message.chat.id, { text, inline_keyboard: screen.inline_keyboard });
      } else {
        await sendScreen(client, message.chat.id, await buildMatchQueryView(env, arg, nowIso));
      }
      break;
    }
    case '/live': {
      const text = deps.onLive ? await deps.onLive(env, nowIso) : 'Live view not wired yet.';
      await sendScreen(client, message.chat.id, { text, inline_keyboard: navButtons('v1:live') });
      break;
    }
    case '/results': {
      const text = deps.onResults ? await deps.onResults(env, nowIso) : 'Results view not wired yet.';
      await sendScreen(client, message.chat.id, { text, inline_keyboard: navButtons('v1:res') });
      break;
    }
    case '/performance': {
      const text = deps.onPerformance
        ? await deps.onPerformance(env, nowIso)
        : 'Performance view not wired yet.';
      await sendScreen(client, message.chat.id, { text, inline_keyboard: navButtons('v1:perf') });
      break;
    }
    default: {
      const home = buildHomeScreen(nowIso);
      await sendScreen(client, message.chat.id, {
        text: `Unknown command <code>${escapeHtml(cmd)}</code>.\n\n${home.text}`,
        inline_keyboard: home.inline_keyboard,
      });
    }
  }

  return { handled: true, allowed: true, command: cmd };
}
