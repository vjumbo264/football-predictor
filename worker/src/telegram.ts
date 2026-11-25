import { parseAllowedIds } from './auth';
import type { Env } from './types';

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

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface OutgoingMessage {
  chat_id: string | number;
  text: string;
  parse_mode: 'HTML';
  disable_web_page_preview: boolean;
}

export type TelegramSender = (msg: OutgoingMessage) => Promise<void>;

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

export function formatStartHelp(): string {
  return [
    '<b>Premier League Match Predictor</b>',
    'Pre-match home / draw / away probabilities, live scores, and a transparent track record.',
    '',
    '<i>Honest note: outcome-prediction accuracy in top leagues is roughly 50–55% at best, and draws are rarely the single most likely result.</i>',
    '',
    '<b>Commands</b>',
    '/today — Today\'s matches &amp; predictions (WAT)',
    '/tomorrow — Tomorrow\'s matches &amp; predictions (WAT)',
    '/match &lt;team&gt; — Next fixture, xG, form &amp; H2H (or <code>/match A vs B</code>)',
    '/live — Live Premier League scores &amp; pre-match picks',
    '/results — Recent finished matches (hit or miss)',
    '/performance — Settled accuracy, baseline &amp; calibration',
    '/help — Show this message',
    '',
    '<i>Statistical estimates only, not guarantees. No odds or betting tips.</i>',
  ].join('\n');
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
): Promise<void> {
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
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  env: Env,
  sender: TelegramSender,
  deps: CommandDependencies = {},
  nowIso: string = new Date().toISOString(),
): Promise<{ handled: boolean; allowed: boolean; command?: string }> {
  const message = update.message ?? update.edited_message;
  if (!message || !message.chat) {
    return { handled: false, allowed: false };
  }

  const userId = String(message.from?.id ?? message.chat.id);
  const allowedIds = parseAllowedIds(env.ALLOWED_TELEGRAM_IDS);
  const isAllowed = allowedIds.has(userId);

  await recordUser(env.DB, message.from, message.chat.id, isAllowed, nowIso);

  if (!isAllowed) {
    await sender({
      chat_id: message.chat.id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: [
        '<b>Access restricted</b>',
        '',
        `Your numeric Telegram ID is: <code>${escapeHtml(userId)}</code>`,
        'Send this ID to the bot owner so they can add you to <code>ALLOWED_TELEGRAM_IDS</code>.',
      ].join('\n'),
    });
    return { handled: true, allowed: false };
  }

  const rawText = (message.text ?? '').trim();
  if (!rawText) {
    await sender({
      chat_id: message.chat.id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: formatStartHelp(),
    });
    return { handled: true, allowed: true, command: '/help' };
  }

  const [head, ...rest] = rawText.split(/\s+/);
  const cmd = head.toLowerCase().split('@')[0];
  const arg = rest.join(' ').trim();

  let reply: string;
  switch (cmd) {
    case '/start':
    case '/help':
      reply = formatStartHelp();
      break;
    case '/today':
      reply = deps.onToday ? await deps.onToday(env, nowIso) : 'Today view not wired yet.';
      break;
    case '/tomorrow':
      reply = deps.onTomorrow ? await deps.onTomorrow(env, nowIso) : 'Tomorrow view not wired yet.';
      break;
    case '/match':
      reply = deps.onMatch ? await deps.onMatch(env, arg, nowIso) : 'Match view not wired yet.';
      break;
    case '/live':
      reply = deps.onLive ? await deps.onLive(env, nowIso) : 'Live view not wired yet.';
      break;
    case '/results':
      reply = deps.onResults ? await deps.onResults(env, nowIso) : 'Results view not wired yet.';
      break;
    case '/performance':
      reply = deps.onPerformance ? await deps.onPerformance(env, nowIso) : 'Performance view not wired yet.';
      break;
    default:
      reply = `Unknown command <code>${escapeHtml(cmd)}</code>.\n\n${formatStartHelp()}`;
  }

  await sender({
    chat_id: message.chat.id,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: reply,
  });

  return { handled: true, allowed: true, command: cmd };
}
