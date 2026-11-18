import { timingSafeEqual } from "node:crypto";

/** Compare fixed-size digests so a supplied secret does not affect comparison timing. */
export async function secretMatches(provided: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(provided)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

export async function publicBase(db: D1Database, requestUrl: string): Promise<string> {
  const saved = await db.prepare("SELECT value FROM settings WHERE key = 'public_url'").first<{ value: string | null }>();
  return saved?.value || new URL(requestUrl).origin;
}

/** Defence in depth for upstream messages that may echo a key. */
export function redact(text: string, secrets: Array<string | null | undefined>): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text;
}

/** Redact strings recursively without corrupting JSON escaping. */
export function redactData<T>(value: T, secrets: Array<string | null | undefined>): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redact(item, secrets);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, visit(val)]));
    return item;
  };
  return visit(value) as T;
}
