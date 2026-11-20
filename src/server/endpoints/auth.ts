import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext, AppEnv } from "../index";
import type { AccessState } from "../../shared/access";
import { SESSION_COOKIE, clearSessionCookie, readSession, sessionCookie, sessionReady, signSession, verifyGoogleIdToken, wallOn, wallReady } from "../services/access";
import { turnstileSiteKey } from "../services/turnstile";

export async function accessEmail(c: AppContext): Promise<string | null> {
  if (!sessionReady(c.env)) return null;
  const email = await readSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET!);
  // A configuration change to the allowed domain also invalidates older sessions.
  return email?.split("@")[1] === c.env.ACCESS_GOOGLE_DOMAIN!.trim().toLowerCase() ? email : null;
}
function state(c: AppContext, email: string | null): AccessState {
  if (!wallOn(c.env)) return { wall: false, ready: true, clientId: null, domain: null, email: null, turnstileSiteKey: turnstileSiteKey(c.env) };
  return { wall: true, ready: wallReady(c.env), clientId: c.env.GOOGLE_CLIENT_ID?.trim() || null, domain: c.env.ACCESS_GOOGLE_DOMAIN!.trim().toLowerCase(), email, turnstileSiteKey: turnstileSiteKey(c.env) };
}

export const auth = new Hono<AppEnv>();
auth.get("/me", async (c) => {
  let email: string | null = null;
  try { email = await accessEmail(c); } catch { /* Fail closed while still showing the sign-in screen. */ }
  return c.json(state(c, email));
});
auth.post("/google", async (c) => {
  if (!wallOn(c.env)) return c.json({ error: "Not found" }, 404);
  if (!wallReady(c.env)) return c.json({ error: "Sign-in is not set up yet." }, 503);
  const body = await c.req.json<{ credential?: unknown }>();
  const result = await verifyGoogleIdToken(typeof body?.credential === "string" ? body.credential : "", {
    clientId: c.env.GOOGLE_CLIENT_ID!.trim(), domain: c.env.ACCESS_GOOGLE_DOMAIN!.trim(),
  });
  if (!result.ok) {
    const error = result.reason === "domain"
      ? `Only addresses at ${c.env.ACCESS_GOOGLE_DOMAIN!.trim().toLowerCase()} can sign in.`
      : result.reason === "expired" ? "Your Google sign-in has expired. Please sign in again."
      : "Your Google sign-in could not be verified. Please try again.";
    return c.json({ error }, 401);
  }
  const value = await signSession(result.email, c.env.SESSION_SECRET!);
  c.header("Set-Cookie", sessionCookie(value));
  return c.json(state(c, result.email));
});
auth.post("/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});
