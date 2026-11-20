import type { AppContext, Bindings } from "../index";

/** The routes a visitor can reach without an agent of their own. Each needs a fresh Turnstile token made for it. */
export type HumanAction = "lookup" | "start";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
type Env = Pick<Bindings, "TURNSTILE_SECRET" | "TURNSTILE_SITE_KEY" | "TURNSTILE_HOSTNAMES">;

/** Turnstile is on when the Worker has both keys. Unset (local development, the tests) it is off and nothing is checked. */
export const turnstileOn = (env: Env): boolean => !!env.TURNSTILE_SECRET?.trim() && !!env.TURNSTILE_SITE_KEY?.trim();

/** The public site key the page renders the widget with, or null while Turnstile is off. */
export const turnstileSiteKey = (env: Env): string | null => turnstileOn(env) ? env.TURNSTILE_SITE_KEY!.trim() : null;

const hostnamesOf = (env: Env): Set<string> => new Set((env.TURNSTILE_HOSTNAMES ?? "").split(",").map(name => name.trim().toLowerCase()).filter(Boolean));

/**
 * Asks Cloudflare whether a token is a real, unused pass for this action on this site.
 * Anything unexpected is a no: a missing token, a failed or slow request, another action,
 * another hostname. A token is spent by this call, so a second request with it is refused.
 */
export async function isHuman(env: Env, token: string | undefined, action: HumanAction, ip?: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET?.trim();
  const hostnames = hostnamesOf(env);
  if (!secret || !token || token.length > 2048 || hostnames.size === 0) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const response = await fetcher(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const result = await response.json() as { success?: boolean; action?: string; hostname?: string; metadata?: { result_with_testing_key?: boolean } };
    if (result.success !== true) return false;
    // Cloudflare's published test secrets answer with no action and "example.com". Only a test
    // secret gets that answer, so it is taken as it is; a real secret must match both.
    if (result.metadata?.result_with_testing_key === true) return true;
    return result.action === action && hostnames.has((result.hostname ?? "").toLowerCase());
  } catch { return false; }
}

/** Null when the request may carry on; otherwise the 403 to send back. */
export async function notHuman(c: AppContext, action: HumanAction): Promise<Response | null> {
  if (!turnstileOn(c.env)) return null;
  if (await isHuman(c.env, c.req.header("x-turnstile-token"), action, c.req.header("CF-Connecting-IP"))) return null;
  return c.json({ error: "We could not confirm you are a person. Try that again.", human: "required" }, 403);
}
