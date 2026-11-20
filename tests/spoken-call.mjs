// End to end, with no person. Builds an agent through the API
// (company, the one-time link, two questions, name and face), then takes one spoken call on
// the /call page: the screening, the offer, and every form in Onboarded's hosted page.
// The candidate's voice is synthesized (macOS `say`) and played into the call as the microphone.
// Places a real, billed voice call and creates a test employee and placement in the connected
// Onboarded account. Every personal detail it gives is made up. See tests/README.md.
//   npm run test:call        (needs `npm run dev:voice` running in this repository; macOS only: it uses `say` and `afconvert`)
//   LABEL=<name for the saved screenshots and call>  WEBSITE=<domain to pull a brand from>
//   TEST_EMAIL_DOMAIN=<domain for the made-up work email>  API=<worker address>  APP=<app address>
//   BASE_URL=<site URL, including its base path> sets app and Worker; otherwise APP and API retain their local defaults.
//   Wall on: .prod.vars needs SESSION_SECRET; TEST_ACCESS_EMAIL defaults to qa@onboarded.com.
//   The wall skips the one-time email link; the Vapi key is still read from .dev.vars.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { micArgs, micScript } from "./lib/fake-mic.mjs";
import { fillPage, submitPage } from "./lib/forms.mjs";
import { CHOICES } from "./lib/choices.mjs";
import { ASSETS, devVar, outDir } from "./lib/paths.mjs";
import { accessCookie } from "./lib/access-cookie.mjs";

const API_BASE = (process.env.BASE_URL ?? process.env.API ?? "http://localhost:8788").replace(/\/$/, "");
const APP = (process.env.BASE_URL ?? process.env.APP ?? "http://localhost:5176").replace(/\/$/, "");
const API = `${API_BASE}/api`;
const accessResponse = await fetch(`${API}/auth/me`);
if (!accessResponse.ok) throw new Error(`Access check failed (${accessResponse.status}).`);
const access = await accessResponse.json();
const accessEmail = process.env.TEST_ACCESS_EMAIL ?? "qa@onboarded.com";
const cookie = access.wall ? await accessCookie({ baseUrl: APP, email: accessEmail }) : null;
const LABEL = process.env.LABEL ?? "call";
const WEBSITE = process.env.WEBSITE ?? "cloudflare.com";
// A reserved domain by default, so no mail can reach a real inbox.
const EMAIL_DOMAIN = process.env.TEST_EMAIL_DOMAIN ?? "larkspur-staffing.example";
const SHOTS = outDir("call");
const AUDIO = outDir("audio");
// Read before the call, so a missing key fails the run before anything is billed.
const VAPI_KEY = devVar("VAPI_PRIVATE_KEY");
let headers = { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie.header } : {}) };
const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};

const LINES = {
  ready: "Yes, I'm ready.",
  pick: "Los Angeles. [[slnc 600]] I live about twenty minutes from there.",
  name: "It's [[slnc 1200]] Maya Torres.",
  hours: "Yes, evenings and weekends work for me. I've worked them for two years.",
  experience: "Three years serving banquets at a conference hotel, [[slnc 900]] and I ran the bar on weekends.",
  noDetail: "No, I'm good on those. Thanks.",
  accept: "Yes, I accept.",
  okay: "Okay, sounds good.",
  hoh: "Hey Ava, quick question. [[slnc 500]] On the W-4, what does head of household mean?",
  which: "Ava, [[slnc 400]] which form am I on right now?",
  thanks: "Okay, got it. Thanks.",
  none: "No, that's everything. Thank you.",
  fallback: "Okay.",
  hello: "Hello? Are you still there?",
};
const wav = {};
for (const [key, text] of Object.entries(LINES)) {
  const aiff = resolve(AUDIO, `${key}.aiff`);
  const out = resolve(AUDIO, `${key}.wav`);
  execFileSync("say", ["-v", "Samantha", "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@48000", "-c", "1", aiff, out]);
  wav[key] = readFileSync(out).toString("base64");
}

/** Which line answers what the agent just said, during the screening. */
const answerTo = (said) => {
  const tail = said.toLowerCase().split(/(?<=[.?!])\s+/).slice(-3).join(" ");
  if (/do you accept|accept the offer|would you like to accept/.test(tail)) return "accept";
  if (/any (other |more )?questions|anything else|questions for me|before we hang up/.test(tail)) return "none";
  if (/legal name|full name/.test(tail)) return "name";
  if (/evening|weekend|shift|work for you|schedule|hours|available|availability/.test(tail) && /\?/.test(tail)) return "hours";
  if (/experience|serving|bartend|work you(’|')?ve done|have you done|done before|tell me about/.test(tail)) return "experience";
  if (/want (detail|me to|more)|go through|any of (them|those)/.test(tail)) return "noDetail";
  if (/which (site|city|one|location)|want to work|wanna work|where would/.test(tail)) return "pick";
  if (/ready\?/.test(tail)) return "ready";
  return "fallback";
};

// -- Build an agent, the way the four steps do --------------------------------------------------
const DESCRIPTION = "We staff banquet servers and bartenders for hotels. I care most about real serving experience, and whether evenings and weekends work for them, because that is most of our shifts.";
const started0 = await api("POST", "/builders", { email: access.wall ? accessEmail : `maya.qa+${Date.now()}@${EMAIL_DOMAIN}`, company: "Larkspur Staffing", website: WEBSITE });
headers = { ...headers, Authorization: `Bearer ${started0.token}` };
console.log("brand", JSON.stringify(started0.builder.brand));
const me0 = await api("GET", "/me");
let blockedStatus = null;
if (!access.wall) {
  if (!me0.devVerifyUrl) throw new Error("No devVerifyUrl: set DEV_SHOW_VERIFY_LINK=1 in .dev.vars");
  const blocked = await fetch(`${API}/me/questions`, { method: "POST", headers, body: JSON.stringify({ description: DESCRIPTION }) });
  blockedStatus = blocked.status;
  await api("POST", "/verify", { token: new URL(me0.devVerifyUrl).searchParams.get("token") });
}
const asked = await api("POST", "/me/questions", { description: DESCRIPTION });
console.log("job", asked.jobTitle, "| questions", JSON.stringify(asked.questions.map((q) => `${q.topic}: ${q.question}`)));
await api("PUT", "/me", { agentName: "Juno", agentFace: 3 });
const built = await api("POST", "/me/build");
const made = await api("POST", "/sessions", { today: new Date().toLocaleDateString("en-CA") });
const link = { sessionId: made.id, token: made.linkToken };
const setup = { blockedStatus, verified: me0.verified, step: me0.step, emailSent: started0.emailSent, questions: asked.questions, brand: started0.builder.brand, built: built.built };
console.log("session", link.sessionId);
const session = () => api("GET", `/sessions/${link.sessionId}`);

// -- The candidate's browser, with the synthesized voice as its microphone --------------------
const browser = await chromium.launch({ args: micArgs() });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["microphone"] });
if (cookie) {
  await ctx.addCookies([cookie.playwright]);
  if (new URL(API_BASE).origin !== new URL(APP).origin) await ctx.addCookies([{ ...cookie.playwright, url: new URL(API_BASE).origin }]);
}
await ctx.addInitScript(micScript);
await ctx.addInitScript(([token, id]) => { localStorage.setItem("bca_token", token); localStorage.setItem("bca_session", id); }, [started0.token, link.sessionId]);
const phone = await ctx.newPage();
phone.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
await phone.goto(`${APP}/call`, { waitUntil: "networkidle" });
let skippedEmailPage = false;
if (access.wall) {
  // CheckEmail sends an already-verified builder straight to questions, even after a reload.
  await phone.goto(`${APP}/check-email`, { waitUntil: "networkidle" });
  const questionsPath = new URL(`${APP}/questions`).pathname;
  await phone.waitForURL((url) => url.pathname === questionsPath, { timeout: 15000 });
  skippedEmailPage = new URL(phone.url()).pathname === questionsPath;
  await phone.goto(`${APP}/call`, { waitUntil: "networkidle" });
}
await phone.screenshot({ path: `${SHOTS}/${LABEL}-1-before.png` });
await phone.locator('[data-testid="candidate-start"]').click();
await phone.locator('[data-testid="candidate-call"][data-state="live"]').waitFor({ timeout: 45000 });
const started = Date.now();
const at = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const speaking = () => phone.evaluate(() => !!document.querySelector('[class*="animate-wave"]')).catch(() => false);
const transcript = async () => (await session()).transcript ?? [];
const live = () => phone.locator('[data-testid="candidate-call"][data-state="live"]').count();
const say = async (key) => {
  const seconds = await phone.evaluate((b64) => window.__say(b64), wav[key]);
  console.log(`${at()}  YOU  (${key}) ${LINES[key]}`);
  await phone.waitForFunction(() => window.__speaking === false, null, { timeout: (seconds + 5) * 1000 });
};
/** Waits until Ava has said something new and has been quiet for a beat. Returns her new words, or null. */
const hearAva = async (afterCount, maxMs = 30000) => {
  const until = Date.now() + maxMs;
  let quietSince = Date.now();
  while (Date.now() < until) {
    await phone.waitForTimeout(200);
    if (await speaking()) { quietSince = Date.now(); continue; }
    if (Date.now() - quietSince < 900) continue;
    const lines = await transcript();
    const fresh = lines.slice(afterCount).filter((l) => l.who === "ai");
    // A holding line ("Let me look at that form") is not the answer.
    if (fresh.length && !/let me (check|pull|look|get)[^.?!]*\W*$/i.test(fresh.at(-1).text.trim())) return fresh.map((l) => l.text).join(" ");
  }
  return null;
};

// == Phase 1: the screening, up to the offer ====================================================
let turns = 0;
let stalls = 0;
let answered = "";
let lastKey = "";
let repeats = 0;
let waitingSince = Date.now();
let accepted = false;
// Pause and resume, once in the screening: Ava must stay silent, then welcome the candidate back and ask again.
let pauseTest = null;
const pauseButton = phone.locator('[data-testid="candidate-pause"]');
const screeningDeadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < screeningDeadline && turns < 26 && (await live()) && !accepted) {
  await phone.waitForTimeout(150);
  if (await speaking()) { waitingSince = Date.now(); continue; }
  if (Date.now() - waitingSince < 800) continue;
  const lines = await transcript();
  const last = lines.at(-1);
  if (!last) continue;
  const heard = `${lines.length}:${last.text}`;
  const holding = last.who === "ai" && /(let me (check|pull|look|get)|give me a moment|(1|one) moment|just a moment)[^.?!]*\W*$/i.test(last.text.trim());
  if (holding && Date.now() - waitingSince < 25000) continue;
  let key;
  if (last.who === "ai" && heard !== answered) {
    const since = [];
    for (let i = lines.length - 1; i >= 0 && lines[i].who === "ai"; i -= 1) since.unshift(lines[i].text);
    key = answerTo(since.join(" "));
    console.log(`${at()}  AVA  ${last.text.slice(-200)}`);
  } else if (Date.now() - waitingSince > 14000) {
    stalls += 1;
    key = "hello";
    console.log(`${at()}  (14 s of silence from Ava)`);
  } else continue;
  if (key === "hours" && pauseTest === null && last.who === "ai") {
    const n = lines.length;
    await pauseButton.click();
    console.log(`${at()}  (paused)`);
    await phone.waitForTimeout(6000);
    const whilePaused = (await transcript()).slice(n).filter((l) => l.who === "ai").map((l) => l.text);
    const shown = await phone.locator('[data-testid="candidate-call"]').innerText();
    await phone.screenshot({ path: `${SHOTS}/${LABEL}-2a-paused.png` });
    await pauseButton.click();
    console.log(`${at()}  (resumed)`);
    const back = await hearAva(n, 20000);
    console.log(`${at()}  AVA  ${String(back).slice(-200)}`);
    pauseTest = { whilePaused, shown: /paused/i.test(shown), back: back ?? "" };
    waitingSince = Date.now();
    continue;
  }
  answered = heard;
  repeats = key === lastKey ? repeats + 1 : 0;
  lastKey = key;
  if (repeats >= 2) { console.log(`${at()}  (the same answer three times in a row: stopping)`); break; }
  await say(key);
  turns += 1;
  if (key === "accept") accepted = true;
  for (let i = 0; i < 40 && (await transcript()).length === lines.length; i += 1) await phone.waitForTimeout(150);
  waitingSince = Date.now();
}
await phone.screenshot({ path: `${SHOTS}/${LABEL}-2-screening.png` });
const afterScreening = await session();
console.log(`${at()}  -- offer: ${afterScreening.journey.offer} | score ${afterScreening.score} | facts ${JSON.stringify(afterScreening.facts)}`);

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
if (access.wall) {
  check("Google sign-in confirms the builder without an email link", setup.verified && setup.step === "questions" && setup.emailSent === false);
  check("check-email carries straight on to questions", skippedEmailPage);
} else check("no step past the email worked before the email was confirmed", setup.blockedStatus === 403, `questions before confirming: ${setup.blockedStatus}`);
check("the description became exactly two questions", setup.questions.length === 2 && setup.questions.every((q) => q.question && q.topic), setup.questions.map((q) => q.topic).join(", "));
check("a brand was found for the website", /^#[0-9A-F]{6}$/i.test(setup.brand.primary) && /^#[0-9A-F]{6}$/i.test(setup.brand.secondary), `${setup.brand.source}: ${setup.brand.primary} / ${setup.brand.secondary}, logo ${setup.brand.logoUrl ? "yes" : "no"}`);
check("the call scored the visitor's two topics", afterScreening.criteria.length === 2 && afterScreening.criteria.every((c) => c.score !== null), afterScreening.criteria.map((c) => `${c.label} ${c.score}`).join(", "));
const spoken = (afterScreening.transcript ?? []).filter((l) => l.who === "ai").map((l) => l.text).join(" ");
check("the agent used its own name and the visitor's company", /juno/i.test(spoken) && /larkspur/i.test(spoken), spoken.slice(0, 120));
check("the agent asked for no email and no start date", !/email|when can you start|start date/i.test(spoken.replace(/starting [a-z]+, [a-z]+ \d+/gi, "")));
{
  const layout = await phone.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const call = document.querySelector('[data-testid="candidate-call"]');
    return { watch: box('[data-testid="watch-view"]'), transcript: box('[data-testid="watch-transcript"]'), api: box('[data-testid="watch-api"]'), forms: box('[data-testid="watch-forms"]'), phoneBg: call ? getComputedStyle(call.querySelector('.a2-phone') ?? call).backgroundColor : null };
  });
  console.log("layout", JSON.stringify(layout));
  check("the right side starts at the top of the page (no bar across it)", !!layout.watch && layout.watch.y <= 2, JSON.stringify(layout.watch));
  check("the transcript is a small strip", !!layout.transcript && layout.transcript.h <= 130, JSON.stringify(layout.transcript));
}
if (pauseTest) {
  check("paused: the page said so and Ava said nothing", pauseTest.shown && pauseTest.whilePaused.length === 0, pauseTest.whilePaused.join(" | ").slice(0, 160));
  check("resumed: Ava welcomed the candidate back and asked again", /welcome back|back/i.test(pauseTest.back) && /\?/.test(pauseTest.back), pauseTest.back.slice(0, 200));
} else check("the pause was tested in the screening", false, "Ava never asked the schedule question");
check("the rule made the offer", accepted && ["offered", "accepted"].includes(afterScreening.journey.offer), `offer: ${afterScreening.journey.offer}, score ${afterScreening.score}`);

// == Phase 2: the forms, on the candidate's screen, with Ava waiting ================================
let unprompted = [];
let formsDone = false;
// Ava's answers to questions the candidate asked while filling in: not her breaking the silence.
const prompted = [];
// Speech recognition writes a form's number as a digit or as a word ("W-four").
const DIGITS = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const bare = (t) => String(t).toLowerCase().replace(/minus/g, "").replace(/\b(one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGITS[w]).replace(/[^a-z0-9]/g, "");
/** "W-4" → "w4", "MVR release" → "mvr": enough of a form's short name to find it in a longer one. */
const mark = (name) => bare(name).replace("release", "");
if (accepted) {
  // The hire is created by start_paperwork; the form app opens when the candidate's page sees it.
  const sheet = phone.locator('[data-testid="agent2-form-sheet"]');
  const opened = await sheet.waitFor({ state: "visible", timeout: 90000 }).then(() => true).catch(() => false);
  check("the form app opened on the candidate's screen during the call", opened && (await live()) > 0);
  const hired = await session();
  check("the hire and its tasks exist in Onboarded", !!hired.hire?.placementId && hired.journey.mine.total > 0, `${hired.journey.mine.total} forms for the candidate, placement ${hired.hire?.placementId ?? "none"}`);

  // Ava says the forms are on screen; then she must go quiet.
  const before = (await transcript()).length;
  const ready = await hearAva(Math.max(0, before - 3), 30000);
  console.log(`${at()}  AVA  ${String(ready).slice(-260)}`);

  // The hosted page, two frames down: the candidate's page > the form app > Onboarded.
  const origin = new URL(hired.hire.onboardingUrl).origin;
  let hosted = null;
  for (let i = 0; i < 150 && !hosted; i += 1) {
    hosted = phone.frames().find((f) => f.url().startsWith(`${origin}/onboarding`)) ?? null;
    if (!hosted) await phone.waitForTimeout(200);
  }
  check("Onboarded's hosted page loaded inside the form app's iframe", !!hosted, hosted ? hosted.url().split("?")[0] : "no frame on the Onboarded origin");
  await phone.waitForTimeout(2500);
  await phone.screenshot({ path: `${SHOTS}/${LABEL}-3-forms-open.png` });
  const sheetTop = async () => Math.round((await sheet.boundingBox())?.y ?? -1);
  const tops = [await sheetTop()];
  const frameAt = () => phone.frames().find((f) => f.url().startsWith(`${origin}/onboarding`)) ?? hosted;
  /** The form Onboarded's page is showing, the form the session says is on screen, and whether they agree. */
  const onScreen = async () => {
    const text = hosted ? await frameAt().locator("body").innerText().catch(() => "") : "";
    const s = await session();
    const now = s.journey.forms.find((f) => f.now) ?? null;
    // The page prints the form's full name ("Forklift Operator Certification"), the session its short one ("Forklift certification").
    const top = bare(text.slice(0, 600));
    const sameForm = !!now && (top.includes(mark(now.name)) || now.name.split(/[^A-Za-z0-9]+/).filter(Boolean).every((word) => top.includes(bare(word))));
    return { text, now, forms: s.journey.forms, agree: sameForm };
  };
  /** Asks Ava which form is on screen and checks her answer against Onboarded's page. */
  const askWhich = async (label) => {
    const seen = await onScreen();
    const n = (await transcript()).length;
    await say("which");
    let reply = await hearAva(n, 40000);
    // Her holding line can arrive in two pieces ("Let me check which form is" / "for you."), and can itself say
    // "form" and "screen" ("which form is on your screen"): wait for the answer itself.
    for (let i = 0; i < 3 && reply && !/\bform\b.*\bnow\b|you are on|you're on/i.test(reply); i += 1) {
      const more = await hearAva((await transcript()).length, 12000);
      if (!more) break;
      reply = `${reply} ${more}`;
    }
    prompted.push(reply ?? "");
    console.log(`${at()}  AVA  ${String(reply).slice(-240)}`);
    console.log(`${at()}  -- Onboarded's page starts: ${JSON.stringify(seen.text.replace(/\s+/g, " ").slice(0, 140))} | session says: ${seen.now?.name ?? "none"}`);
    check(`${label}: the session knows the form on Onboarded's page`, seen.agree, `session: ${seen.now?.name ?? "none"}`);
    check(`${label}: Ava named the form on the candidate's screen`, !!seen.now && bare(reply ?? "").includes(mark(seen.now.name)), String(reply).slice(0, 160));
    return seen;
  };

  if (hosted) {
    const apiAtForms = (await session()).api.length;
    const first = await askWhich("at the start");
    check("the forms open in the order of the requirements table", first.now?.taskId === first.forms.filter((f) => f.state !== "done" && f.state !== "part")[0]?.taskId && first.now?.taskId === first.forms[0]?.taskId, `first: ${first.now?.name}, table: ${first.forms.map((f) => f.name).join(", ")}`);
    tops.push(await sheetTop());
    // A question about the form, mid-fill: she has to read the form to answer it.
    const linesBefore = (await transcript()).length;
    const apiBefore = (await session()).api.length;
    await say("hoh");
    const answer = await hearAva(linesBefore, 40000);
    console.log(`${at()}  AVA  ${String(answer).slice(-300)}`);
    prompted.push(answer ?? "");
    tops.push(await sheetTop());
    // She may answer from the read she made for the question before: the form is the same one.
    const read = (await session()).api.slice(apiAtForms);
    check("Ava read the form from Onboarded before answering about it", read.some((c) => c.path.startsWith("/forms/")) && read.some((c) => /\/fields/.test(c.path)), read.map((c) => `${c.method} ${c.path}`).join(", ").slice(0, 160));
    check("her answer came from the form's own words", /unmarried|more than half|qualifying/i.test(answer ?? ""), String(answer).slice(0, 140));
    const beforeThanks = (await transcript()).length;
    await say("thanks");
    // She may answer the thanks ("You're welcome"): that is a reply, not her breaking the silence.
    await hearAva(beforeThanks, 9000);
    await phone.waitForTimeout(1500);
    await phone.screenshot({ path: `${SHOTS}/${LABEL}-4-question.png` });

    // The form at full height: the caption goes, the hosted page stays loaded.
    const expand = phone.locator('[data-testid="agent2-expand"]');
    const topBefore = await sheetTop();
    await expand.click();
    await phone.waitForTimeout(400);
    const topWide = await sheetTop();
    await phone.screenshot({ path: `${SHOTS}/${LABEL}-4a-expanded.png` });
    check("Expand form gives the form the caption's space, without reloading Onboarded's page", topWide < topBefore - 60 && (await phone.locator('[data-testid="agent2-caption"]').count()) === 0 && !frameAt().isDetached(), `form top ${topBefore}px → ${topWide}px`);
    await expand.click();
    await phone.waitForTimeout(400);
    tops.push(await sheetTop());

    // Fill every form in the hosted page. Ava should speak only when a form is done.
    const quietFrom = (await transcript()).length;
    const signer = `${hired.candidate.first} ${hired.candidate.last}`;
    const files = resolve(ASSETS, "sample-passport.png");
    phone.setDefaultTimeout(6000);
    const frameNow = () => phone.frames().find((f) => f.url().startsWith(`${origin}/onboarding`)) ?? hosted;
    let lastDone = 0;
    for (let page = 0; page < 70 && (await live()); page += 1) {
      const f = frameNow();
      await f.waitForLoadState("networkidle").catch(() => {});
      const s = await session();
      if (s.journey.mine.done !== lastDone) {
        lastDone = s.journey.mine.done;
        console.log(`${at()}  -- ${lastDone} of ${s.journey.mine.total} of the candidate's forms done`);
        await phone.screenshot({ path: `${SHOTS}/${LABEL}-5-done-${lastDone}.png` });
        tops.push(await sheetTop());
        if (lastDone === 1 && s.journey.mine.total > 1) {
          // Pause and resume while filling in.
          await phone.waitForTimeout(5000);
          const n = (await transcript()).length;
          await pauseButton.click();
          await phone.waitForTimeout(4000);
          await pauseButton.click();
          const back = await hearAva(n, 15000);
          prompted.push(back ?? "");
          console.log(`${at()}  AVA  (after a pause) ${String(back).slice(-160)}`);
          check("resumed while filling in: Ava said she is still there", /back|still (here|on the line)|here/i.test(back ?? ""), String(back).slice(0, 160));
          tops.push(await sheetTop());
        }
        if (lastDone === 2 && s.journey.mine.total > 2) {
          // Two forms in: she must say the third, not the first.
          await phone.waitForTimeout(6000);
          await frameAt().waitForLoadState("networkidle").catch(() => {});
          await phone.waitForTimeout(2500);
          await askWhich("two forms in");
          tops.push(await sheetTop());
        }
      }
      if (s.journey.mine.total > 0 && s.journey.mine.done === s.journey.mine.total) { formsDone = true; break; }
      const again = f.getByRole("button", { name: /continue here|try again/i });
      if (await again.count().catch(() => 0)) { await again.first().click().catch(() => {}); await phone.waitForTimeout(1500); continue; }
      const submit = f.locator('button[type="submit"]').last();
      const found = await submit.waitFor({ state: "visible", timeout: 9000 }).then(() => true).catch(() => false);
      if (!found) { await phone.waitForTimeout(2000); continue; }
      await phone.waitForTimeout(900);
      try {
        await fillPage(f, { choices: CHOICES, files, signer, pace: 0, log: (m) => process.env.VERBOSE && console.log(`        ${m}`) });
        await phone.waitForTimeout(300);
        const url = f.url();
        const label = await submitPage(f);
        for (let k = 0; k < 60 && f.url() === url; k += 1) await phone.waitForTimeout(100);
        if (process.env.VERBOSE) console.log(`        submitted (${label})`);
        await phone.waitForTimeout(500);
      } catch (error) {
        console.log(`        form page tried again: ${String(error.message).split("\n")[0].slice(0, 140)}`);
        await phone.waitForTimeout(800);
      }
    }
    phone.setDefaultTimeout(30000);
    // The last form's completion is picked up by the page's next reads.
    for (let i = 0; i < 40 && !formsDone; i += 1) {
      const s = await session();
      formsDone = s.journey.mine.total > 0 && s.journey.mine.done === s.journey.mine.total;
      if (!formsDone) await phone.waitForTimeout(1000);
    }
    const end = await session();
    check("every form of the candidate's is done", formsDone, `${end.journey.mine.done} of ${end.journey.mine.total}`);

    // What Ava said while the candidate typed: one line per finished form, nothing else.
    await phone.waitForTimeout(9000);
    const during = (await transcript()).slice(quietFrom).filter((l) => l.who === "ai").map((l) => l.text);
    const announcements = during.filter((t) => /(is|are) in\.|all set|last (one|1)/i.test(t));
    // Her announcements arrive in the transcript a sentence at a time.
    unprompted = during.filter((t) => !/(is|are) in\.|all set|last (one|1)|more to go|hang up|confirms? your start|^got it[.,]?$/i.test(t.trim()));
    // What she said in answer to a question or after a pause is not unprompted.
    unprompted = unprompted.filter((t) => !prompted.some((p) => bare(p).includes(bare(t))));
    check("the form stayed where it was while Ava's caption changed", new Set(tops).size === 1, `form top at ${[...new Set(tops)].join(", ")}px over ${tops.length} readings`);
    const named = end.journey.forms.map((f) => f.name).filter((name) => during.some((t) => bare(t).includes(bare(name))));
    check("each announcement named the form that was finished", named.length >= Math.min(2, end.journey.mine.total - 1), `named: ${named.join(", ")}`);
    console.log(`${at()}  -- Ava while the candidate typed: ${JSON.stringify(during)}`);
    check("Ava said when forms were done", announcements.length >= 1, `${announcements.length} announcements`);
    check("Ava stayed silent otherwise while the candidate typed", unprompted.length === 0, unprompted.join(" | ").slice(0, 200));
    await phone.screenshot({ path: `${SHOTS}/${LABEL}-6-all-set.png` });
    const view = await fetch(`${API}/public/interviews/${link.token}`, { headers }).then((r) => r.json());
    check("the candidate's page says all set", view.formApp?.allSet === true, JSON.stringify({ ...view.formApp, url: "…" }));

    // Her closing question, then goodbye.
    if (await live()) {
      const n = (await transcript()).length;
      await say("none");
      const bye = await hearAva(n, 20000);
      console.log(`${at()}  AVA  ${String(bye).slice(-200)}`);
    }
  }
}
await phone.waitForTimeout(6000);
const endedByAva = (await live()) === 0;
if (!endedByAva && (await phone.getByRole("button", { name: "End call" }).count())) await phone.getByRole("button", { name: "End call" }).click();
await phone.waitForTimeout(2500);
await phone.screenshot({ path: `${SHOTS}/${LABEL}-7-after.png` });

// The final state, as the watch view reads it.
let final = await session();
for (let i = 0; i < 10 && final.status === "live"; i += 1) { await new Promise((r) => setTimeout(r, 1500)); final = await session(); }
check("the session ended approved, with a hire", final.status === "approved" && !!final.hire?.placementId, `status ${final.status}`);
check("the journey has four steps and no payroll", final.journey.steps.length === 4 && final.journey.steps.every((s) => !/payroll/i.test(`${s.label} ${s.detail}`)), final.journey.steps.map((s) => s.label).join(", "));
await browser.close();

// -- Read the call back from Vapi ---------------------------------------------------------------
let call = null;
for (let i = 0; i < 20; i += 1) {
  const list = await (await fetch("https://api.vapi.ai/call?limit=1", { headers: { Authorization: `Bearer ${VAPI_KEY}` } })).json();
  call = list[0];
  if (call?.status === "ended" && (call.artifact?.messages?.length ?? 0) > 2) break;
  await new Promise((r) => setTimeout(r, 3000));
}
// The saved call holds the whole transcript and Vapi's configuration; it stays under tests/out.
writeFileSync(resolve(outDir("calls"), `${LABEL}-${call.id}.json`), JSON.stringify(call, null, 1));
const messages = (call.artifact?.messages ?? []).filter((m) => m.role !== "system");
console.log(`\nVapi call ${call.id}, ${messages.length} messages, ${Math.round((call.artifact?.messages?.at(-1)?.secondsFromStart ?? 0))} s, cost $${call.cost}, ended: ${call.endedReason}`);
let double = 0;
let askedThisTurn = false;
let toolsSinceUser = [];
for (const m of messages) {
  const start = (m.secondsFromStart ?? 0).toFixed(1).padStart(6);
  const text = m.message ?? "";
  if (m.role === "user") { askedThisTurn = false; toolsSinceUser = []; console.log(`${start}  user  ${text}`); }
  else if (m.role === "bot") {
    // After a pause Ava asks her question again on purpose: that is not a doubled question.
    const doubled = askedThisTurn && text.includes("?") && toolsSinceUser.length === 0 && !/^welcome back/i.test(text.trim());
    if (doubled) double += 1;
    if (text.includes("?")) askedThisTurn = true;
    console.log(`${start}  AVA   ${text}${doubled ? "   <-- QUESTION HEARD TWICE" : ""}`);
  } else if (m.role === "tool_calls") {
    toolsSinceUser.push(...m.toolCalls.map((t) => t.function.name));
    console.log(`${start}        tool ${m.toolCalls.map((t) => `${t.function.name} ${t.function.arguments.replace(/\s+/g, " ").slice(0, 100)}`).join("; ")}`);
  } else if (m.role === "tool_call_result") console.log(`${start}        result ${String(m.result).slice(0, 130)}`);
}
check("no question heard twice", double === 0, `${double}`);
check("no dead air in the screening", stalls === 0, `${stalls} stalls`);
console.log(`\njourney: ${final.journey.steps.map((s) => `${s.label} [${s.state}] ${s.detail}`).join("\n         ")}`);
console.log(`RESULT  ${checks.filter((c) => c.ok).length} of ${checks.length} checks passed${checks.some((c) => !c.ok) ? `   FAILED: ${checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}` : ""}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
