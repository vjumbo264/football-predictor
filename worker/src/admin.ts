import { isAdminUser, listAllowedUsers, parseAdminIds, parseAllowedIds } from './auth';
import type { Env, InlineKeyboardButton, RenderedScreen } from './types';

export interface TelegramUserInfo {
  id: number;
  first_name?: string;
  username?: string;
}

export interface AdminTelegramBridge {
  sendMessage: (msg: {
    chat_id: string | number;
    text: string;
    parse_mode: 'HTML';
    disable_web_page_preview: boolean;
    reply_markup?: unknown;
  }) => Promise<void>;
  editMessageText: (msg: {
    chat_id: string | number;
    message_id: number;
    text: string;
    parse_mode: 'HTML';
    disable_web_page_preview: boolean;
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  }) => Promise<void>;
  answerCallbackQuery: (payload: {
    callback_query_id: string;
    text?: string;
    show_alert?: boolean;
  }) => Promise<void>;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRequesterLabel(firstName?: string | null, username?: string | null, id?: string): string {
  const parts: string[] = [];
  if (firstName) parts.push(firstName);
  if (username) parts.push(`@${username}`);
  if (!parts.length && id) return id;
  return parts.join(' ');
}

export interface AccessRequestRow {
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  status: 'pending' | 'approved' | 'declined';
  requested_at: string;
  last_notified_user_at: string | null;
  admin_notified_at: string | null;
}

export async function handleUnapprovedMessage(
  env: Env,
  user: TelegramUserInfo | undefined,
  chatId: number,
  nowIso: string,
  bridge: AdminTelegramBridge,
): Promise<void> {
  const userId = String(user?.id ?? chatId);
  const existing = await env.DB
    .prepare(
      `SELECT telegram_id, username, first_name, status, requested_at, last_notified_user_at, admin_notified_at
       FROM access_requests WHERE telegram_id = ?`,
    )
    .bind(userId)
    .first<AccessRequestRow>();

  if (existing) {
    if (existing.status === 'declined') {
      // Silently ignore declined users until an admin approves them later.
      return;
    }

    if (existing.status === 'pending') {
      // Update profile info if changed, never duplicate admin notifications.
      await env.DB
        .prepare(
          `UPDATE access_requests
           SET username = COALESCE(?, username),
               first_name = COALESCE(?, first_name)
           WHERE telegram_id = ?`,
        )
        .bind(user?.username ?? null, user?.first_name ?? null, userId)
        .run();

      const lastMs = existing.last_notified_user_at ? Date.parse(existing.last_notified_user_at) : 0;
      const nowMs = Date.parse(nowIso);
      if (!existing.last_notified_user_at || nowMs - lastMs >= 24 * 3600_000) {
        await env.DB
          .prepare('UPDATE access_requests SET last_notified_user_at = ? WHERE telegram_id = ?')
          .bind(nowIso, userId)
          .run();
        await bridge.sendMessage({
          chat_id: chatId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          text: [
            '🔒 <b>Private bot</b>',
            'This bot is private and your request is still waiting for owner approval.',
          ].join('\n'),
        });
      }
      return;
    }
  }

  // First message from an unapproved user (or previously removed user).
  await env.DB
    .prepare(
      `INSERT INTO access_requests (
         telegram_id, username, first_name, status, requested_at, last_notified_user_at, admin_notified_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, NULL)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = COALESCE(excluded.username, access_requests.username),
                     first_name = COALESCE(excluded.first_name, access_requests.first_name),
                     status = 'pending',
                     requested_at = excluded.requested_at,
                     last_notified_user_at = excluded.last_notified_user_at,
                     admin_notified_at = NULL,
                     decided_by = NULL,
                     decided_at = NULL`,
    )
    .bind(userId, user?.username ?? null, user?.first_name ?? null, nowIso, nowIso)
    .run();

  await bridge.sendMessage({
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: [
      '🔒 <b>Private bot</b>',
      'This bot is private. Your request has been sent to the owner — please wait for approval.',
    ].join('\n'),
  });

  const adminIds = Array.from(parseAdminIds(env));
  const nameLine = user?.first_name ? escapeHtml(user.first_name) : '<i>Unknown</i>';
  const usernameLine = user?.username ? `@${escapeHtml(user.username)}` : '<i>none</i>';
  const adminText = [
    '🔔 <b>New access request</b>',
    `Name: ${nameLine}`,
    `Username: ${usernameLine}`,
    `ID: <code>${escapeHtml(userId)}</code>`,
  ].join('\n');

  let notifiedAnyAdmin = false;
  for (const adminId of adminIds) {
    try {
      await bridge.sendMessage({
        chat_id: adminId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: adminText,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `v1:adm:app:${userId}` },
              { text: '❌ Decline', callback_data: `v1:adm:dec:${userId}` },
            ],
          ],
        },
      });
      notifiedAnyAdmin = true;
    } catch {
      // Admin may not have initiated /start yet; request stays pending in D1 for /pending.
    }
  }

  if (notifiedAnyAdmin) {
    await env.DB
      .prepare('UPDATE access_requests SET admin_notified_at = ? WHERE telegram_id = ?')
      .bind(nowIso, userId)
      .run();
  }
}

export async function approveUserById(
  env: Env,
  targetId: string,
  adminId: string,
  nowIso: string,
): Promise<{ username: string | null; first_name: string | null }> {
  const req = await env.DB
    .prepare('SELECT username, first_name FROM access_requests WHERE telegram_id = ?')
    .bind(targetId)
    .first<{ username: string | null; first_name: string | null }>();
  const usr = await env.DB
    .prepare('SELECT username, first_name FROM users WHERE telegram_id = ?')
    .bind(targetId)
    .first<{ username: string | null; first_name: string | null }>();

  const username = req?.username ?? usr?.username ?? null;
  const firstName = req?.first_name ?? usr?.first_name ?? null;

  await env.DB
    .prepare(
      `INSERT INTO allowed_users (telegram_id, username, first_name, added_by, added_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = COALESCE(excluded.username, allowed_users.username),
                     first_name = COALESCE(excluded.first_name, allowed_users.first_name),
                     added_by = excluded.added_by,
                     added_at = excluded.added_at`,
    )
    .bind(targetId, username, firstName, adminId, nowIso)
    .run();

  await env.DB
    .prepare(
      `INSERT INTO users (telegram_id, username, first_name, is_allowed, last_seen_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (telegram_id)
       DO UPDATE SET is_allowed = 1,
                     username = COALESCE(excluded.username, users.username),
                     first_name = COALESCE(excluded.first_name, users.first_name)`,
    )
    .bind(targetId, username, firstName, nowIso)
    .run();

  await env.DB
    .prepare(
      `UPDATE access_requests
       SET status = 'approved', decided_by = ?, decided_at = ?
       WHERE telegram_id = ?`,
    )
    .bind(adminId, nowIso, targetId)
    .run();

  return { username, first_name: firstName };
}

export async function declineUserById(
  env: Env,
  targetId: string,
  adminId: string,
  nowIso: string,
): Promise<{ username: string | null; first_name: string | null }> {
  const req = await env.DB
    .prepare('SELECT username, first_name FROM access_requests WHERE telegram_id = ?')
    .bind(targetId)
    .first<{ username: string | null; first_name: string | null }>();

  await env.DB
    .prepare(
      `INSERT INTO access_requests (
         telegram_id, username, first_name, status, requested_at, decided_by, decided_at
       ) VALUES (?, ?, ?, 'declined', ?, ?, ?)
       ON CONFLICT (telegram_id)
       DO UPDATE SET status = 'declined',
                     decided_by = excluded.decided_by,
                     decided_at = excluded.decided_at`,
    )
    .bind(targetId, req?.username ?? null, req?.first_name ?? null, nowIso, adminId, nowIso)
    .run();

  await env.DB
    .prepare('DELETE FROM allowed_users WHERE telegram_id = ?')
    .bind(targetId)
    .run();

  await env.DB
    .prepare('UPDATE users SET is_allowed = 0 WHERE telegram_id = ?')
    .bind(targetId)
    .run();

  return { username: req?.username ?? null, first_name: req?.first_name ?? null };
}

export async function removeUserById(
  env: Env,
  targetId: string,
): Promise<{ status: 'removed' | 'is_admin' | 'in_secret' | 'not_found'; message: string }> {
  if (isAdminUser(env, targetId)) {
    return {
      status: 'is_admin',
      message: `⚠️ Cannot remove admin ID <code>${escapeHtml(targetId)}</code>.`,
    };
  }

  const del = await env.DB
    .prepare('DELETE FROM allowed_users WHERE telegram_id = ?')
    .bind(targetId)
    .run();
  await env.DB
    .prepare('DELETE FROM access_requests WHERE telegram_id = ?')
    .bind(targetId)
    .run();
  await env.DB
    .prepare('UPDATE users SET is_allowed = 0 WHERE telegram_id = ?')
    .bind(targetId)
    .run();

  if (parseAllowedIds(env.ALLOWED_TELEGRAM_IDS).has(targetId)) {
    return {
      status: 'in_secret',
      message: `⚠️ <code>${escapeHtml(targetId)}</code> is set in the <code>ALLOWED_TELEGRAM_IDS</code> Worker secret (any D1 entry was removed, but the secret still grants access until updated).`,
    };
  }

  if ((del.meta?.changes ?? 0) === 0) {
    return {
      status: 'not_found',
      message: `User <code>${escapeHtml(targetId)}</code> was not in the allowed list.`,
    };
  }

  return {
    status: 'removed',
    message: `🗑 Removed user <code>${escapeHtml(targetId)}</code>. They will be treated as a new unapproved user if they message again.`,
  };
}

export async function buildPendingScreen(env: Env): Promise<RenderedScreen> {
  const { results } = await env.DB
    .prepare(
      `SELECT telegram_id, username, first_name, requested_at
       FROM access_requests
       WHERE status = 'pending'
       ORDER BY requested_at ASC
       LIMIT 15`,
    )
    .all<{
      telegram_id: string;
      username: string | null;
      first_name: string | null;
      requested_at: string;
    }>();

  if (!results.length) {
    return {
      text: '<b>Pending Access Requests</b>\nNo pending requests right now.',
      inline_keyboard: [
        [
          { text: '🔄 Refresh', callback_data: 'v1:adm:pend' },
          { text: '🏠 Home', callback_data: 'v1:home' },
        ],
      ],
    };
  }

  const lines: string[] = [`<b>Pending Access Requests (${results.length})</b>`];
  const inline_keyboard: InlineKeyboardButton[][] = [];

  for (const r of results) {
    const label = formatRequesterLabel(r.first_name, r.username, r.telegram_id);
    lines.push(
      `• <b>${escapeHtml(label)}</b> — ID <code>${escapeHtml(r.telegram_id)}</code>`,
    );
    const shortBtn = (r.first_name || r.username || r.telegram_id).slice(0, 12);
    inline_keyboard.push([
      { text: `✅ Approve ${shortBtn}`, callback_data: `v1:adm:app:${r.telegram_id}` },
      { text: `❌ Decline ${shortBtn}`, callback_data: `v1:adm:dec:${r.telegram_id}` },
    ]);
  }

  inline_keyboard.push([
    { text: '🔄 Refresh', callback_data: 'v1:adm:pend' },
    { text: '🏠 Home', callback_data: 'v1:home' },
  ]);

  return { text: lines.join('\n'), inline_keyboard };
}

export async function buildUsersScreen(env: Env): Promise<RenderedScreen> {
  const users = await listAllowedUsers(env);
  if (!users.length) {
    return {
      text: '<b>Approved Users</b>\nNo users configured.',
      inline_keyboard: [[{ text: '🏠 Home', callback_data: 'v1:home' }]],
    };
  }

  const lines: string[] = [`<b>Approved Users (${users.length})</b>`];
  const inline_keyboard: InlineKeyboardButton[][] = [];

  for (const u of users) {
    const label = formatRequesterLabel(u.first_name, u.username, u.telegram_id);
    const roleTag =
      u.source === 'admin' ? 'admin' : u.source === 'secret' ? 'secret' : 'approved';
    lines.push(
      `• <b>${escapeHtml(label)}</b> — <code>${escapeHtml(u.telegram_id)}</code> (${roleTag})`,
    );
    if (u.removable) {
      const shortBtn = (u.first_name || u.username || u.telegram_id).slice(0, 16);
      inline_keyboard.push([
        { text: `🗑 Remove ${shortBtn}`, callback_data: `v1:adm:rem:${u.telegram_id}` },
      ]);
    }
  }

  inline_keyboard.push([
    { text: '🔄 Refresh', callback_data: 'v1:adm:users' },
    { text: '🏠 Home', callback_data: 'v1:home' },
  ]);

  return { text: lines.join('\n'), inline_keyboard };
}
