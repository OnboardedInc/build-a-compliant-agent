import type { Bindings } from "../index";

/** Rewrites of the two questions one agent can ask for in a day. Each one is a model request. */
export const MAX_REWRITES_PER_DAY = 10;
/** Agents one internet address can start in a day, whichever email is typed. An office shares one address. */
export const MAX_AGENTS_PER_ADDRESS = 10;

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
