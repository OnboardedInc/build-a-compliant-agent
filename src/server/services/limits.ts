import type { Bindings } from "../index";

/** Rewrites of the two questions one agent can ask for in a day. Each one is a model request. */
export const MAX_REWRITES_PER_DAY = 10;
/** Agents one internet address can start in a day, whichever email is typed. An office shares one address. */
export const MAX_AGENTS_PER_ADDRESS = 10;

/** Agents one email address can start in any 24 hours. Every "New agent" is a start, and every start sends one confirmation link. */
export const MAX_STARTS_PER_EMAIL = 10;
export const DAY_MS = 86_400_000;

/**
 * What a visitor over the email limit is told: the limit, and how long until the oldest start
 * of the last 24 hours ages out and makes room. The wait is rounded up, so it never promises
 * a time that is too early.
 */
export function tooManyAgents(oldestStart: string | null | undefined, nowMs: number = Date.now()): string {
  const said = `You've created ${MAX_STARTS_PER_EMAIL} agents with this email in the last 24 hours, which is the limit.`;
  const minutes = oldestStart ? Math.ceil((Date.parse(oldestStart) + DAY_MS - nowMs) / 60_000) : NaN;
  if (!Number.isFinite(minutes)) return `${said} You can create another one tomorrow.`;
  if (minutes <= 1) return `${said} You can create another one in a minute.`;
  if (minutes < 60) return `${said} You can create another one in about ${minutes} minutes.`;
  const hours = Math.ceil(minutes / 60);
  return `${said} You can create another one in about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Counts one more use of a key today (UTC). False when today's limit is already reached, and
 * then nothing is counted. The check and the count are one statement, so two requests at once
 * cannot both take the last place. A database without the table (a deploy before its
 * migration) counts nothing and lets the request through.
 */
export async function countUse(db: D1Database, key: string, limit: number): Promise<boolean> {
  try {
    const result = await db.prepare("INSERT INTO usage_counts (key, day, n) VALUES (?, ?, 1) ON CONFLICT(key, day) DO UPDATE SET n = n + 1 WHERE n < ?").bind(key, today(), limit).run();
    return (result.meta.changes ?? 0) > 0;
  } catch { return true; }
}

/**
 * The visitor's internet address as Cloudflare reports it, or null when there is none to count:
 * local development reports the machine's own loopback address for every request.
 */
export const countedAddress = (header: string | undefined): string | null => {
  const address = header?.trim().toLowerCase();
  return address && !/^(127\.|::1$|::ffff:127\.)/.test(address) ? address : null;
};

/** The key agents are counted under for one internet address. The address itself is not stored: only a salted hash of it. */
export async function addressKey(env: Pick<Bindings, "ADMIN_TOKEN">, address: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.ADMIN_TOKEN ?? ""}|${address.trim().toLowerCase()}`)));
  return `agents:${Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
