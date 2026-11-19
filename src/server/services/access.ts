// Import-free so the Worker and Node's native TypeScript loader use the same verifier.
type AccessEnv = { ACCESS_GOOGLE_DOMAIN?: string; GOOGLE_CLIENT_ID?: string; SESSION_SECRET?: string };
export const SESSION_COOKIE = "__Host-bca_auth";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export const wallOn = (env: AccessEnv): boolean => typeof env.ACCESS_GOOGLE_DOMAIN === "string" && !!env.ACCESS_GOOGLE_DOMAIN.trim();
/** Session cookies can be checked: the wall is on and SESSION_SECRET is long enough. Without it every protected route answers 503. */
export const sessionReady = (env: AccessEnv): boolean => wallOn(env) && typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32;
/** Google sign-in works: sessions can be checked and GOOGLE_CLIENT_ID is set. Without the client id nobody can sign in, so protected routes answer 401. */
export const wallReady = (env: AccessEnv): boolean => sessionReady(env) && typeof env.GOOGLE_CLIENT_ID === "string" && !!env.GOOGLE_CLIENT_ID.trim();

function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("Invalid base64url");
  return bytes;
}
function objectPart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(part)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid object");
  return parsed as Record<string, unknown>;
}

type GoogleKey = JsonWebKey & { kid?: string };
let keyCache: { keys: GoogleKey[]; expires: number } | null = null;
async function googleKeys(force = false): Promise<{ keys: GoogleKey[]; cached: boolean }> {
  if (!force && keyCache && keyCache.expires > Date.now()) return { keys: keyCache.keys, cached: true };
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!response.ok) throw new Error("Google keys unavailable");
  const data = await response.json() as { keys?: GoogleKey[] };
  if (!Array.isArray(data.keys) || !data.keys.every((key) => key && typeof key === "object")) throw new Error("Invalid Google keys");
  const maxAge = response.headers.get("Cache-Control")?.match(/\bmax-age\s*=\s*"?(\d+)/i)?.[1];
  keyCache = { keys: data.keys, expires: Date.now() + (maxAge === undefined ? 3600 : Number(maxAge)) * 1000 };
  return { keys: keyCache.keys, cached: false };
}

export type GoogleTokenResult = { ok: true; email: string } | { ok: false; reason: "malformed" | "alg" | "kid" | "keys" | "signature" | "issuer" | "audience" | "expired" | "unverified" | "domain" };
export async function verifyGoogleIdToken(idToken: string, options: { clientId: string; domain: string; now?: number; keys?: () => Promise<JsonWebKey[]> }): Promise<GoogleTokenResult> {
  let parts: string[], header: Record<string, unknown>, claims: Record<string, unknown>, signature: Uint8Array<ArrayBuffer>;
  try {
    parts = idToken.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    header = objectPart(parts[0]);
    claims = objectPart(parts[1]);
  } catch { return { ok: false, reason: "malformed" }; }
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "kid" };
  try { signature = decode(parts[2]); } catch { return { ok: false, reason: "malformed" }; }
  let jwk: GoogleKey | undefined;
  try {
    if (options.keys) jwk = (await options.keys() as GoogleKey[]).find((key) => key.kid === header.kid);
    else {
      const set = await googleKeys();
      jwk = set.keys.find((key) => key.kid === header.kid);
      // A cached set can predate a rotation. A freshly fetched set needs no second fetch.
      if (!jwk && set.cached) jwk = (await googleKeys(true)).keys.find((key) => key.kid === header.kid);
    }
  } catch { return { ok: false, reason: "keys" }; }
  if (!jwk) return { ok: false, reason: "kid" };
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, encoder.encode(`${parts[0]}.${parts[1]}`))) return { ok: false, reason: "signature" };
  } catch { return { ok: false, reason: "signature" }; }
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") return { ok: false, reason: "issuer" };
  if (!options.clientId || !(claims.aud === options.clientId || Array.isArray(claims.aud) && claims.aud.includes(options.clientId))) return { ok: false, reason: "audience" };
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 + 60_000 <= now) return { ok: false, reason: "expired" };
  if (claims.email_verified !== true && claims.email_verified !== "true") return { ok: false, reason: "unverified" };
  const domain = options.domain.trim().toLowerCase();
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!domain || typeof claims.hd !== "string" || claims.hd.toLowerCase() !== domain || !/^[^\s@]+@[^\s@]+$/.test(email) || email.split("@")[1] !== domain) return { ok: false, reason: "domain" };
  return { ok: true, email };
}

const sessionKey = (secret: string, usage: "sign" | "verify") => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
export async function signSession(email: string, secret: string, nowMs = Date.now(), ttlMs = SESSION_TTL_MS): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify({ e: email.toLowerCase(), x: Math.floor((nowMs + ttlMs) / 1000) })));
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(secret, "sign"), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function readSession(value: string | null | undefined, secret: string, nowMs = Date.now()): Promise<string | null> {
  try {
    if (typeof value !== "string") return null;
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const data = objectPart(parts[0]);
    const valid = await crypto.subtle.verify("HMAC", await sessionKey(secret, "verify"), decode(parts[1]), encoder.encode(parts[0]));
    if (!valid || !Number.isFinite(nowMs) || typeof data.x !== "number" || !Number.isFinite(data.x) || data.x * 1000 <= nowMs || typeof data.e !== "string" || !/^[^\s@]+@[^\s@]+$/.test(data.e)) return null;
    return data.e.toLowerCase();
  } catch { return null; }
}
export const sessionCookie = (value: string): string => `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`;
export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
