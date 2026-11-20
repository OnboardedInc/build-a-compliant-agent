import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";
import { auth, accessEmail } from "./endpoints/auth";
import { builders, builderAuth, type BuilderRow } from "./endpoints/builders";
import * as sessions from "./endpoints/sessions";
import { brandFor, safeDomain } from "./services/brand";
import { DEFAULT_BRAND } from "../shared/builder";
import { basePath, route, withBase } from "../shared/base-path";
import { secretMatches, redactData } from "./services/security";
import { SESSION_COOKIE, sessionReady, wallOn } from "./services/access";
import { notHuman } from "./services/turnstile";
import { personalEmailProblem } from "./services/emailDomains";

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_PATH?: string;
  ONBOARDED_API_BASE?: string;
  ONBOARDED_API_KEY?: string;
  ONBOARDED_EMPLOYER_ID?: string;
  ONBOARDED_JOB_ID?: string;
  VAPI_PRIVATE_KEY?: string;
  VAPI_ORG_ID?: string;
  BRAND_DEV_API_KEY?: string;
  ADMIN_TOKEN?: string;
  ACCESS_GOOGLE_DOMAIN?: string;
  /** "off" skips the one-time confirmation link: a new builder is confirmed at once. For a Worker with no way to send mail. */
  EMAIL_CONFIRMATION?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Cloudflare Turnstile. With the secret and the site key set, the company lookup and starting an agent need a fresh token. Unset, nothing is checked. */
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  /** The site's own hostnames, comma-separated. A token made on any other page is refused. */
  TURNSTILE_HOSTNAMES?: string;
  /** A Slack incoming webhook. With it set, each agent a visitor finishes building is posted to that channel. */
  SLACK_WEBHOOK_URL?: string;
  SESSION_SECRET?: string;
  DEV_SHOW_VERIFY_LINK?: string;
  /** "1" sends the employer's I-9 Section 2 link to the browser. Off by default. */
  SHOW_EMPLOYER_LINK?: string;
  EMAIL: SendEmail;
  EMAIL_FROM: string;
  SITE_NAME: string;
}
export type AppEnv = { Bindings: Bindings; Variables: { builder: BuilderRow; accessEmail: string } };
export type AppContext = Context<AppEnv>;
const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
  if (c.res.headers.get("Content-Type")?.includes("application/json")) {
    const secrets = [c.env.ONBOARDED_API_KEY, c.env.VAPI_PRIVATE_KEY, c.env.ADMIN_TOKEN, c.env.BRAND_DEV_API_KEY, c.env.SESSION_SECRET, c.env.TURNSTILE_SECRET, c.env.SLACK_WEBHOOK_URL, getCookie(c, SESSION_COOKIE), c.res.headers.get("Set-Cookie")?.match(/^__Host-bca_auth=([^;]+)/)?.[1], c.get("builder")?.token, c.req.header("x-bca-tool-secret"), ...(c.req.path.startsWith("/api/mcp/") ? [c.req.header("Authorization")?.replace(/^Bearer\s+/i, "")] : [])];
    const data: unknown = await c.res.clone().json();
    c.res = new Response(JSON.stringify(redactData(data, secrets)), { status: c.res.status, headers: c.res.headers });
  }
});
app.use("/api/*", async (c, next) => {
  if (!wallOn(c.env) || c.req.path === "/api/health" || c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/vapi/")) return next();
  if (!sessionReady(c.env)) return c.json({ error: "Sign-in is not set up yet.", signIn: "unavailable" }, 503);
  let email: string | null = null;
  try { email = await accessEmail(c); } catch { /* An invalid cookie or failed check never opens the wall. */ }
  if (!email) return c.json({ error: "Sign in with your Google work account.", signIn: "required" }, 401);
  c.set("accessEmail", email);
  return next();
});
app.route("/api/auth", auth);
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.post("/api/brand/preview", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const domain = typeof body?.website === "string" ? safeDomain(body.website) : null;
  // The redesigned first screen looks the company up from the work email, and says here that a personal address will not do.
  const personal = typeof body?.email === "string" && !wallOn(c.env) ? personalEmailProblem(body.email) : null;
  if (personal) return c.json({ error: "Check the highlighted fields.", errors: [{ field: "email", message: personal }] }, 400);
  // A lookup can cost a brand.dev request, and anyone can ask for one.
  const refused = domain ? await notHuman(c, "lookup") : null;
  if (refused) return refused;
  return c.json(domain ? await brandFor(domain, c.env) : DEFAULT_BRAND);
});
app.route("/api", builders);
app.use("/api/sessions", builderAuth);
app.use("/api/sessions/*", builderAuth);
app.post("/api/sessions", sessions.createInterview);
app.get("/api/sessions/latest", sessions.latestInterview);
app.get("/api/sessions/:id", sessions.getInterview);
app.post("/api/sessions/:id/approve", sessions.approveInterview);
app.get("/api/public/interviews/:token", sessions.getCandidateInterview);
app.post("/api/public/interviews/:token/call", sessions.startCandidateCall);
app.post("/api/public/interviews/:token/events", sessions.postCandidateEvents);
app.post("/api/public/interviews/:token/mcp", sessions.candidateMcp);
app.post("/api/mcp/:id", sessions.sessionMcp);
app.post("/api/vapi/tool-calls/:id", sessions.vapiToolCalls);
app.put("/api/admin/public-url", async (c) => {
  if (!(await secretMatches(c.req.header("Authorization")?.replace(/^Bearer\s+/i, ""), c.env.ADMIN_TOKEN))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await c.req.json<{ url?: unknown }>();
  let url: string | null = null;
  if (body?.url !== null) {
    if (typeof body?.url !== "string") return c.json({ error: "Use a public HTTPS URL or null." }, 400);
    try {
      const parsed = new URL(body.url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !safeDomain(parsed.hostname) || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error();
      url = parsed.origin;
    } catch { return c.json({ error: "Use a public HTTPS origin or null." }, 400); }
  }
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('public_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(url).run();
  return c.json({ url });
});
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  if (error instanceof SyntaxError) return c.json({ error: "Send valid JSON." }, 400);
  if (error instanceof HTTPException) return c.json({ error: "Request could not be processed." }, error.status);
  // No raw exception, request URL, headers or body: any of them can hold credentials.
  console.error("Worker request failed");
  return c.json({ error: "Something went wrong. Try again." }, 500);
});
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The site has one address: www goes to the bare domain, path and query kept.
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return new Response(null, { status: 301, headers: { Location: url.toString() } });
    }
    const base = basePath(env.BASE_PATH);
    if (!base) return app.fetch(request, env, ctx);
    const target = route(base, url.pathname);
    if (target.kind === "hono") return app.fetch(request, env, ctx);
    if (target.kind === "redirect") return new Response(null, { status: target.status, headers: { Location: `${target.to}${url.search}` } });
    if (target.kind === "app-api") {
      url.pathname = target.path;
      return app.fetch(new Request(url, request), env, ctx);
    }
    const insideApp = target.kind === "app-page";
    url.pathname = insideApp ? withBase(base, "/index.html") : "/index.html";
    url.search = "";
    const asset = await env.ASSETS.fetch(new Request(url, { method: request.method === "HEAD" ? "HEAD" : "GET" }));
    if (!asset.ok) return asset;
    const response = new Response(asset.body, { status: target.kind === "root" ? target.status : 200, headers: asset.headers });
    if (insideApp) response.headers.set("Cache-Control", "no-cache");
    return response;
  },
};
