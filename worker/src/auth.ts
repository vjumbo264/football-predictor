import type { Env } from './types';

/** Constant-time string comparison to avoid timing side-channels on shared secrets. */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function verifyBearerToken(authHeader: string | null, expectedSecret: string | undefined): boolean {
  if (!authHeader || !expectedSecret) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return false;
  return constantTimeEqual(match[1], expectedSecret);
}

export function parseAllowedIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  );
}

export function parseAdminIds(env: Env): Set<string> {
  return parseAllowedIds(env.ADMIN_TELEGRAM_IDS);
}

export function isAdminUser(env: Env, userId: string): boolean {
  return parseAdminIds(env).has(userId);
}

export async function isUserAllowed(env: Env, userId: string): Promise<boolean> {
  if (isAdminUser(env, userId)) return true;
  if (parseAllowedIds(env.ALLOWED_TELEGRAM_IDS).has(userId)) return true;
  const row = await env.DB
    .prepare('SELECT 1 AS ok FROM allowed_users WHERE telegram_id = ?')
    .bind(userId)
    .first<{ ok: number }>();
  return row?.ok === 1;
}

export async function getAllAllowedUserIds(env: Env): Promise<string[]> {
  const merged = new Set<string>([
    ...parseAdminIds(env),
    ...parseAllowedIds(env.ALLOWED_TELEGRAM_IDS),
  ]);
  const { results } = await env.DB
    .prepare('SELECT telegram_id FROM allowed_users ORDER BY added_at ASC')
    .all<{ telegram_id: string }>();
  for (const r of results) {
    if (/^\d+$/.test(r.telegram_id)) {
      merged.add(r.telegram_id);
    }
  }
  return Array.from(merged);
}

export interface AllowedUserEntry {
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  source: 'admin' | 'secret' | 'db';
  removable: boolean;
}

export async function listAllowedUsers(env: Env): Promise<AllowedUserEntry[]> {
  const admins = parseAdminIds(env);
  const secrets = parseAllowedIds(env.ALLOWED_TELEGRAM_IDS);
  const { results: dbAllowed } = await env.DB
    .prepare('SELECT telegram_id, username, first_name FROM allowed_users ORDER BY added_at ASC')
    .all<{ telegram_id: string; username: string | null; first_name: string | null }>();
  const { results: knownUsers } = await env.DB
    .prepare('SELECT telegram_id, username, first_name FROM users')
    .all<{ telegram_id: string; username: string | null; first_name: string | null }>();
  const profileMap = new Map<string, { username: string | null; first_name: string | null }>();
  for (const u of knownUsers) {
    profileMap.set(u.telegram_id, { username: u.username, first_name: u.first_name });
  }
  for (const u of dbAllowed) {
    const existing = profileMap.get(u.telegram_id);
    profileMap.set(u.telegram_id, {
      username: u.username ?? existing?.username ?? null,
      first_name: u.first_name ?? existing?.first_name ?? null,
    });
  }

  const allIds = new Set<string>([...admins, ...secrets, ...dbAllowed.map((r) => r.telegram_id)]);
  const entries: AllowedUserEntry[] = [];
  for (const id of allIds) {
    const prof = profileMap.get(id);
    const isAdm = admins.has(id);
    const isSec = secrets.has(id);
    entries.push({
      telegram_id: id,
      username: prof?.username ?? null,
      first_name: prof?.first_name ?? null,
      source: isAdm ? 'admin' : isSec ? 'secret' : 'db',
      removable: !isAdm && !isSec,
    });
  }
  return entries;
}
