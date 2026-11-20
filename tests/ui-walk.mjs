// Walks the building steps in a real browser, as a visitor would, and saves a screenshot of
// each screen at desktop and phone width (tests/out/ui/).
//   npm run test:ui      (needs `npm run dev:voice` or `npm run dev` running; APP defaults to http://localhost:5176)
//   APP=<app address>  WEBSITE=<domain to pull a brand from>  TEST_EMAIL_DOMAIN=<domain for the made-up work email>
//   BASE_URL=<site URL, including its base path> sets app and Worker; otherwise APP and API retain their local defaults.
//   Wall on: .prod.vars must contain SESSION_SECRET; TEST_ACCESS_EMAIL defaults to qa@onboarded.com.
import { chromium } from "playwright";
import { outDir } from "./lib/paths.mjs";
import { accessCookie } from "./lib/access-cookie.mjs";

const APP = (process.env.BASE_URL ?? process.env.APP ?? "http://localhost:5176").replace(/\/$/, "");
const API_BASE = (process.env.BASE_URL ?? process.env.API ?? "http://localhost:8788").replace(/\/$/, "");
const atPage = (path) => (url) => url.pathname === new URL(`${APP}${path}`).pathname;
const atHome = (url) => atPage("/")(url) || url.pathname === new URL(APP).pathname;
const accessResponse = await fetch(`${API_BASE}/api/auth/me`);
if (!accessResponse.ok) throw new Error(`Access check failed (${accessResponse.status}).`);
const access = await accessResponse.json();
const accessEmail = process.env.TEST_ACCESS_EMAIL ?? "qa@onboarded.com";
const cookie = access.wall ? await accessCookie({ baseUrl: APP, email: accessEmail }) : null;
const WEBSITE = process.env.WEBSITE ?? "cloudflare.com";
// A reserved domain by default, so no mail can reach a real inbox.
const EMAIL_DOMAIN = process.env.TEST_EMAIL_DOMAIN ?? "larkspur-staffing.example";
const SHOTS = outDir("ui");
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// A first visit to /call asks for the latest session and is told there is none (404): expected.
// Over HTTP/2 (a deployed site) the browser logs it as "404 ()", with no status text.
page.on("console", (m) => { if (m.type() === "error" && !/status of 404 \((Not Found)?\)/.test(m.text())) errors.push(m.text()); });
const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${name}-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: `${SHOTS}/${name}-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  return overflow;
};

// A later step is not reachable before the first.
await page.goto(`${APP}/questions`, { waitUntil: "networkidle" });
if (cookie) {
  await page.getByTestId("sign-in").waitFor({ timeout: 15000 });
  check("the internal preview requires sign-in without a cookie", await page.getByTestId("sign-in").isVisible());
  await ctx.addCookies([cookie.playwright]);
  if (new URL(API_BASE).origin !== new URL(APP).origin) await ctx.addCookies([{ ...cookie.playwright, url: new URL(API_BASE).origin }]);
  await page.reload({ waitUntil: "networkidle" });
}
await page.waitForURL(atHome, { timeout: 15000 });
await page.getByLabel("Work email").waitFor();
check("a visitor with nothing built is sent to step 1", atHome(new URL(page.url())), page.url());

// Step 1: a personal address is refused, then a work address goes through.
await page.getByLabel("Work email").fill("someone@gmail.com");
await page.getByLabel("Company name").fill("Larkspur Staffing");
await page.getByLabel("Company website").fill(WEBSITE);
await page.getByLabel("Company name").focus();
await page.getByText(/found on/i).first().waitFor({ timeout: 30000 }).catch(() => {});
check("step 1 shows what was found on the website", (await page.getByText(/found on/i).count()) > 0);
await page.getByRole("button", { name: /continue/i }).click();
await page.getByText(/gmail\.com are not accepted/i).first().waitFor({ timeout: 8000 }).catch(() => {});
check("a personal email is refused at the field", (await page.getByText(/gmail\.com are not accepted/i).count()) > 0 && atHome(new URL(page.url())));
await page.getByLabel("Work email").fill(access.wall ? accessEmail : `maya.ui+${Date.now()}@${EMAIL_DOMAIN}`);
const o1 = await shot("1-company");
check("step 1 fits a phone", o1 <= 1, `overflow ${o1}px`);
await page.getByRole("button", { name: /continue/i }).click();
if (access.wall) {
  await page.waitForURL(atPage("/questions"), { timeout: 30000 });
  check("the company step carries straight on to questions with Google sign-in", atPage("/questions")(new URL(page.url())));
} else {
  await page.waitForURL(atPage("/check-email"), { timeout: 30000 });
  // Step 2: the page waits, and carries on when the one-time link is opened elsewhere.
  const o2 = await shot("2-check-email");
  check("step 2 fits a phone", o2 <= 1, `overflow ${o2}px`);
  const linkText = await page.getByText(/\/verify\?token=/).first().textContent().catch(() => null);
  const href = linkText?.match(/https?:\/\/\S+\/verify\?token=[\w-]+/)?.[0] ?? (await page.locator('a[href*="/verify?token="]').first().getAttribute("href").catch(() => null));
  check("local development shows the one-time link", !!href);
  const other = await ctx.newPage();
  await other.goto(`${APP}/verify?token=${new URL(href).searchParams.get("token")}`, { waitUntil: "networkidle" });
  await other.waitForURL(atPage("/questions"), { timeout: 15000 }).catch(() => {});
  check("opening the link lands on the questions", atPage("/questions")(new URL(other.url())), other.url());
  await other.close();
  await page.waitForURL(atPage("/questions"), { timeout: 15000 }).catch(() => {});
  check("the waiting page carried on by itself", atPage("/questions")(new URL(page.url())), page.url());
}

// Step 3: a description becomes two questions; one can be edited.
await page.getByLabel(/your screening/i).fill("We staff banquet servers and bartenders for hotels. I care most about real serving experience, and whether evenings and weekends work for them, because that is most of our shifts.");
await page.getByRole("button", { name: /write my two questions/i }).click();
await page.getByText(/scored as/i).first().waitFor({ timeout: 60000 });
const cards = await page.getByText(/scored as/i).count();
check("the description became two question cards", cards === 2, `${cards} cards`);
const body3 = await page.locator("body").innerText();
check("step 3 shows no Vapi configuration", !/vapi|firstMessage|"model"/i.test(body3));
check("step 3 says it is two questions", /two screening questions/i.test(body3));
const o3 = await shot("3-questions");
check("step 3 fits a phone", o3 <= 1, `overflow ${o3}px`);
await page.getByRole("button", { name: /edit question 1/i }).click();
await page.getByLabel("Question 1").fill("Tell me about the serving or bartending work you have done, and where.");
await page.getByRole("button", { name: /^save/i }).click();
await page.getByText("and where.").first().waitFor({ timeout: 10000 }).catch(() => {});
check("a question's wording can be edited", (await page.getByText("and where.").count()) > 0);
await page.getByRole("link", { name: /continue/i }).or(page.getByRole("button", { name: /continue/i })).first().click();
await page.waitForURL(atPage("/name"), { timeout: 15000 });

// Step 4: a name of at most eight characters and one of ten faces.
await page.getByLabel("Agent name").fill("Junojunojuno");
const typed = await page.getByLabel("Agent name").inputValue();
check("the name stops at 8 characters", typed.length <= 8, typed);
await page.getByLabel("Agent name").fill("Juno");
const faces = await page.getByRole("button", { name: /^face \d+/i }).count();
check("ten faces to choose from", faces === 10, `${faces}`);
await page.getByRole("button", { name: /^face 3/i }).click();
const o4 = await shot("4-name");
check("step 4 fits a phone", o4 <= 1, `overflow ${o4}px`);
await page.getByRole("button", { name: /build my agent/i }).click();
await page.waitForURL(atPage("/built"), { timeout: 15000 });

// Step 5, then the call screen.
await page.waitForTimeout(3500);
const body5 = await page.locator("body").innerText();
check("the built screen names the agent and has no payroll", /juno/i.test(body5) && !/payroll/i.test(body5));
const o5 = await shot("5-built");
check("step 5 fits a phone", o5 <= 1, `overflow ${o5}px`);
await page.getByRole("link", { name: /take a test call/i }).or(page.getByRole("button", { name: /take a test call/i })).first().click();
await page.waitForURL(atPage("/call"), { timeout: 15000 });
await page.locator('[data-testid="candidate-start"]').waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
const layout = await page.evaluate(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return { watch: box('[data-testid="watch-view"]'), call: box('[data-testid="candidate-call"]'), transcript: box('[data-testid="watch-transcript"]'), forms: box('[data-testid="watch-forms"]'), api: box('[data-testid="watch-api"]') };
});
console.log("layout", JSON.stringify(layout));
check("the call screen: the right side starts at the top, beside the phone", !!layout.watch && layout.watch.y <= 2 && layout.watch.x >= 380, JSON.stringify(layout.watch));
const steps6 = await page.locator('[aria-label="Journey"] li').allInnerTexts();
check("the call screen has four steps and no payroll step", steps6.length === 4 && !steps6.some((t) => /payroll/i.test(t)), steps6.map((t) => t.split("\n")[0]).join(", "));
const bar = await page.evaluate(() => { const el = document.querySelector(".call-nav"); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
check("the bar is one slim row above the phone only", !!bar && bar.h <= 50 && bar.w <= 440, JSON.stringify(bar));
const o6 = await shot("6-call");
check("the call screen fits a phone", o6 <= 1, `overflow ${o6}px`);
check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 300));
await browser.close();
console.log(`RESULT  ${checks.filter((c) => c.ok).length} of ${checks.length} checks passed${checks.some((c) => !c.ok) ? `   FAILED: ${checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}` : ""}`);
