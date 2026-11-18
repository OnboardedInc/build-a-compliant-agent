import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { builders, builderAuth, type BuilderRow } from "./endpoints/builders";
import * as sessions from "./endpoints/sessions";
import { brandFor, safeDomain } from "./services/brand";
import { DEFAULT_BRAND } from "../shared/builder";
import { secretMatches, redactData } from "./services/security";

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  ONBOARDED_API_BASE?: string;
  ONBOARDED_API_KEY?: string;
  ONBOARDED_EMPLOYER_ID?: string;
  ONBOARDED_JOB_ID?: string;
  VAPI_PRIVATE_KEY?: string;
  VAPI_ORG_ID?: string;
  BRAND_DEV_API_KEY?: string;
  ADMIN_TOKEN?: string;
  DEV_SHOW_VERIFY_LINK?: string;
  /** "1" sends the employer's I-9 Section 2 link to the browser. Off by default. */
  SHOW_EMPLOYER_LINK?: string;
  EMAIL: SendEmail;
  EMAIL_FROM: string;
  SITE_NAME: string;
}
export type AppEnv = { Bindings: Bindings; Variables: { builder: BuilderRow } };
export type AppContext = Context<AppEnv>;
const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
  if (c.res.headers.get("Content-Type")?.includes("application/json")) {
    const secrets = [c.env.ONBOARDED_API_KEY, c.env.VAPI_PRIVATE_KEY, c.env.ADMIN_TOKEN, c.env.BRAND_DEV_API_KEY, c.get("builder")?.token, c.req.header("x-bca-tool-secret"), ...(c.req.path.startsWith("/api/mcp/") ? [c.req.header("Authorization")?.replace(/^Bearer\s+/i, "")] : [])];
    const data: unknown = await c.res.clone().json();
    c.res = new Response(JSON.stringify(redactData(data, secrets)), { status: c.res.status, headers: c.res.headers });
  }
});
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.post("/api/brand/preview", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const domain = typeof body?.website === "string" ? safeDomain(body.website) : null;
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
export default app;
