import { verifyBearerToken, constantTimeEqual } from './auth';
import { handleLiveCommand, handleResultsCommand } from './commands_live_results';
import { handleDayCommand, handleMatchCommand } from './commands_schedule';
import { IngestValidationError, getApiUsage, ingestData, utcDateStr } from './db';
import { handlePerformanceCommand, runGradingPass } from './grading';
import { runMorningDigest } from './morning';
import type { FetchLike } from './sources';
import {
  createTelegramClient,
  handleTelegramUpdate,
  type CommandDependencies,
  type TelegramClient,
  type TelegramSender,
  type TelegramUpdate,
} from './telegram';
import type { Env, IngestPayload } from './types';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export interface RequestTestHooks {
  sender?: TelegramSender;
  telegram?: TelegramClient;
  deps?: CommandDependencies;
  fetchFn?: FetchLike;
}

export function buildCommandDeps(fetchFn: FetchLike = fetch): CommandDependencies {
  return {
    onToday: (env, nowIso) => handleDayCommand(env, 0, nowIso),
    onTomorrow: (env, nowIso) => handleDayCommand(env, 1, nowIso),
    onMatch: (env, query, nowIso) => handleMatchCommand(env, query, nowIso),
    onLive: (env, nowIso) => handleLiveCommand(env, nowIso, fetchFn),
    onResults: (env, nowIso) => handleResultsCommand(env, nowIso),
    onPerformance: (env, nowIso) => handlePerformanceCommand(env, nowIso),
  };
}

export async function handleRequest(
  request: Request,
  env: Env,
  nowIso: string = new Date().toISOString(),
  hooks: RequestTestHooks = {},
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    const dbCheck = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const today = utcDateStr(nowIso);
    const apiFootballCalls = await getApiUsage(env.DB, 'api_football', today);
    const cap = Number(env.API_DAILY_CAP ?? '80');
    return jsonResponse({
      ok: dbCheck?.ok === 1,
      service: 'football-predictor',
      timestamp_utc: nowIso,
      api_budget: {
        provider: 'api_football',
        date_utc: today,
        used: apiFootballCalls,
        cap,
      },
    });
  }

  if (request.method === 'POST' && url.pathname === '/ingest') {
    if (!verifyBearerToken(request.headers.get('Authorization'), env.INGEST_SECRET)) {
      return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
    }
    let payload: IngestPayload;
    try {
      payload = (await request.json()) as IngestPayload;
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    try {
      const summary = await ingestData(env.DB, payload, nowIso);
      return jsonResponse({ ok: true, summary }, 200);
    } catch (err) {
      if (err instanceof IngestValidationError) {
        return jsonResponse({ ok: false, error: err.message }, err.status);
      }
      throw err;
    }
  }

  if (request.method === 'POST' && url.pathname === '/grade') {
    if (!verifyBearerToken(request.headers.get('Authorization'), env.INGEST_SECRET)) {
      return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
    }
    const summary = await runGradingPass(env, nowIso, hooks.fetchFn ?? fetch);
    return jsonResponse({ ok: true, summary }, 200);
  }

  if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
    const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!constantTimeEqual(headerSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    }
    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid Telegram update JSON' }, 400);
    }
    const transport: TelegramSender | TelegramClient =
      hooks.telegram ?? hooks.sender ?? createTelegramClient(env.TELEGRAM_BOT_TOKEN, hooks.fetchFn ?? fetch);
    const deps: CommandDependencies = {
      ...buildCommandDeps(hooks.fetchFn ?? fetch),
      ...hooks.deps,
    };
    const result = await handleTelegramUpdate(update, env, transport, deps, nowIso);
    return jsonResponse({ ok: true, ...result }, 200);
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const nowIso = new Date().toISOString();
    await runGradingPass(env, nowIso);
    await runMorningDigest(env, nowIso);
  },
};
