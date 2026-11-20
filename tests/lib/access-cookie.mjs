import { signSession, SESSION_COOKIE } from "../../src/server/services/access.ts";
import { prodVar } from "./paths.mjs";

/** A synthetic preview session for deployed-site tests. Never print its value or header. */
export async function accessCookie({ baseUrl, email = "qa@onboarded.com" }) {
  const secret = prodVar("SESSION_SECRET");
  if (secret.length < 32) throw new Error("SESSION_SECRET in .prod.vars must contain at least 32 characters.");
  const value = await signSession(email, secret);
  const name = SESSION_COOKIE;
  return { name, value, header: `${name}=${value}`, playwright: { name, value, url: new URL(baseUrl).origin, secure: true, httpOnly: true, sameSite: "Lax" } };
}
