/** Rewrites of the two questions one agent can ask for in a day. Each one is a model request. */
export const MAX_REWRITES_PER_DAY = 10;

/** Agents one email address can start in any 24 hours. Every "New agent" is a start, and every start sends one confirmation link. */
export const MAX_STARTS_PER_EMAIL = 10;
export const DAY_MS = 86_400_000;
/** Test calls one agent can start in any 24 hours. Each one is a voice call and an employee in the shared Onboarded account. */
export const MAX_SESSIONS_PER_DAY = 15;

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
