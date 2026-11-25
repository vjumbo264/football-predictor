import { getAllAllowedUserIds } from './auth';
import { handleDayCommand, lagosDateStr } from './commands_schedule';
import { createTelegramSender, type TelegramSender } from './telegram';
import type { Env } from './types';

function lagosHour(isoUtc: string): number {
  const ms = Date.parse(isoUtc) + 3600 * 1000;
  return new Date(ms).getUTCHours();
}

export async function runMorningDigest(
  env: Env,
  nowIso: string = new Date().toISOString(),
  sender: TelegramSender = createTelegramSender(env.TELEGRAM_BOT_TOKEN),
): Promise<{ sent: number; skipped: number; reason?: string }> {
  if (lagosHour(nowIso) < 8) {
    return { sent: 0, skipped: 0, reason: 'before_08_wat' };
  }

  const league = env.DEFAULT_LEAGUE ?? 'E0';
  const todayWat = lagosDateStr(nowIso);
  const { results: fixtures } = await env.DB
    .prepare('SELECT kickoff_utc FROM fixtures WHERE league = ?')
    .bind(league)
    .all<{ kickoff_utc: string }>();

  const hasMatchesToday = fixtures.some((f) => lagosDateStr(f.kickoff_utc) === todayWat);
  if (!hasMatchesToday) {
    return { sent: 0, skipped: 0, reason: 'no_matches_today' };
  }

  const allowedIds = await getAllAllowedUserIds(env);
  if (!allowedIds.length) {
    return { sent: 0, skipped: 0, reason: 'no_allowed_users' };
  }

  const digestText = await handleDayCommand(env, 0, nowIso);
  let sent = 0;
  let skipped = 0;

  for (const userId of allowedIds) {
    await env.DB
      .prepare(
        `INSERT INTO users (telegram_id, is_allowed, last_seen_at, last_morning_date)
         VALUES (?, 1, ?, NULL)
         ON CONFLICT (telegram_id) DO NOTHING`,
      )
      .bind(userId, nowIso)
      .run();

    const claim = await env.DB
      .prepare(
        `UPDATE users
         SET last_morning_date = ?
         WHERE telegram_id = ?
           AND (last_morning_date IS NULL OR last_morning_date != ?)`,
      )
      .bind(todayWat, userId, todayWat)
      .run();

    if ((claim.meta?.changes ?? 0) === 0) {
      skipped += 1;
      continue;
    }

    try {
      await sender({
        chat_id: userId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: `☀️ <b>Morning Matchday Brief</b>\n\n${digestText}`,
      });
      sent += 1;
    } catch {
      // Do not fail grading cron if a user hasn't initiated /start with the bot yet.
      skipped += 1;
    }
  }

  return { sent, skipped };
}
