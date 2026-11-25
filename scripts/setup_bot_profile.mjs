#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const botDisplayName = (process.env.BOT_DISPLAY_NAME || 'Football Predictor').trim();
const workerUrl = process.env.WORKER_URL?.trim().replace(/\/+$/, '') || '';
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || '';
const dropPending = process.argv.includes('--drop-pending-updates') || process.env.DROP_PENDING_UPDATES === 'true';

const COMMANDS = [
  { command: 'menu', description: 'Open the main menu' },
  { command: 'today', description: "Today's matches" },
  { command: 'tomorrow', description: "Tomorrow's matches" },
  { command: 'match', description: 'Find a team or match' },
  { command: 'live', description: 'Live scores' },
  { command: 'results', description: 'Recent results' },
  { command: 'performance', description: 'How accurate the bot has been' },
  { command: 'help', description: 'How to use this bot' },
];

const DESCRIPTION =
  'Premier League match predictor. Get honest win, draw, and loss probabilities, live scores, recent results, and our real accuracy track record in one tap.\n\n' +
  'Predictions are statistical estimates locked before kickoff — never guarantees or betting tips. Top-flight football is unpredictable (roughly 50–55% accuracy at best).';

const SHORT_DESCRIPTION =
  'Honest Premier League match probabilities, live scores, results, and track record. Estimates only, not guarantees.';

async function tg(method, body, allowError = false) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok && !allowError) {
    throw new Error(`Telegram ${method} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  // 1. Clean slate for commands across scopes and common language codes
  const scopes = [
    undefined,
    { type: 'default' },
    { type: 'all_private_chats' },
    { type: 'all_group_chats' },
    { type: 'all_chat_administrators' },
  ];
  const langCodes = [undefined, 'en'];

  for (const scope of scopes) {
    for (const language_code of langCodes) {
      const payload = {};
      if (scope) payload.scope = scope;
      if (language_code) payload.language_code = language_code;
      const existing = await tg('getMyCommands', payload);
      if (Array.isArray(existing.result) && existing.result.length > 0) {
        await tg('deleteMyCommands', payload);
      } else {
        await tg('deleteMyCommands', payload, true);
      }
    }
  }

  // 2. Set the exact new command list on default scope
  await tg('setMyCommands', { commands: COMMANDS });

  // 3. Set chat menu button to commands
  await tg('setChatMenuButton', { menu_button: { type: 'commands' } });

  // 4. Set bot display name & descriptions
  await tg('setMyName', { name: botDisplayName });
  await tg('setMyDescription', { description: DESCRIPTION });
  await tg('setMyShortDescription', { short_description: SHORT_DESCRIPTION });

  // 5. Try setting profile photo via Bot API if supported (best-effort)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const avatarPath = path.resolve(here, '../assets/avatar.png');
  let photoStatus = 'skipped (assets/avatar.png missing)';
  if (fs.existsSync(avatarPath)) {
    const bytes = fs.readFileSync(avatarPath);
    const form = new FormData();
    form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
    form.append('avatar', new Blob([bytes], { type: 'image/png' }), 'avatar.png');
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, {
      method: 'POST',
      body: form,
    });
    const photoData = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (photoData.ok) {
      photoStatus = 'updated via setMyProfilePhoto';
    } else {
      photoStatus = `unavailable/refused (${photoData.error_code ?? res.status}: ${photoData.description ?? 'unknown'})`;
    }
  }

  // 6. Configure webhook if WORKER_URL and TELEGRAM_WEBHOOK_SECRET are supplied
  let webhookStatus = 'skipped (WORKER_URL or TELEGRAM_WEBHOOK_SECRET not provided)';
  if (workerUrl && webhookSecret) {
    const webhookRes = await tg('setWebhook', {
      url: `${workerUrl}/telegram/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: dropPending,
    });
    webhookStatus = webhookRes.description || 'set';
  }

  // 7. Verify getters
  const me = await tg('getMe', {});
  const myName = await tg('getMyName', {});
  const cmdsDefault = await tg('getMyCommands', {});
  const cmdsPrivate = await tg('getMyCommands', { scope: { type: 'all_private_chats' } });
  const cmdsEn = await tg('getMyCommands', { language_code: 'en' });
  const desc = await tg('getMyDescription', {});
  const shortDesc = await tg('getMyShortDescription', {});
  const menuBtn = await tg('getChatMenuButton', {});

  console.log(
    JSON.stringify(
      {
        me: { id: me.result.id, username: me.result.username, first_name: me.result.first_name },
        myName: myName.result,
        commandsDefault: cmdsDefault.result,
        commandsPrivateCount: cmdsPrivate.result.length,
        commandsEnCount: cmdsEn.result.length,
        descriptionLength: desc.result.description.length,
        shortDescriptionLength: shortDesc.result.short_description.length,
        menuButton: menuBtn.result,
        profilePhoto: photoStatus,
        webhook: webhookStatus,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
