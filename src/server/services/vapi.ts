// Vapi voice calls for the AI interviewer. The Worker creates the web call
// with a short-lived token signed by the org's private key, and the browser
// only joins it, so the key, the prompt and the tool secret never reach the
// browser. Ava's tools are server tools: Vapi posts each tool call to this
// Worker and waits for the result before she speaks.

import {
  MAX_CALL_SECONDS,
  longDay,
  type VoiceJoin,
} from "../../shared/interview";

import type { ScreeningQuestion } from "../../shared/builder";

const VAPI = "https://api.vapi.ai";

export interface VapiConfig {
  privateKey: string;
  orgId: string;
  toolBaseUrl: string | null;
}

export interface VapiEnv {
  VAPI_PRIVATE_KEY?: string;
  VAPI_ORG_ID?: string;
}

export async function getVapiConfig(db: D1Database, env: VapiEnv = {}): Promise<VapiConfig | null> {
  const key = env.VAPI_PRIVATE_KEY?.trim();
  if (!key) return null;
  let orgId = env.VAPI_ORG_ID?.trim() || (await db.prepare("SELECT value FROM settings WHERE key = 'vapi_org_id'").first<{ value: string | null }>())?.value;
  if (!orgId) {
    orgId = await discoverOrgId(key);
    // Remember it, so the next call does not look it up again.
    if (orgId) await db.prepare("INSERT INTO settings (key, value) VALUES ('vapi_org_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(orgId).run();
  }
  if (!orgId) return null;
  const saved = await db.prepare("SELECT value FROM settings WHERE key = 'public_url'").first<{ value: string | null }>();
  return { privateKey: key, orgId, toolBaseUrl: saved?.value ?? null };
}

/** The Vapi org a private key belongs to, read from the key's own token list. */
async function discoverOrgId(privateKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${VAPI}/token?limit=1`, {
      headers: { Authorization: `Bearer ${privateKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ orgId?: string }> | { results?: Array<{ orgId?: string }> };
    const list = Array.isArray(body) ? body : (body.results ?? []);
    return list[0]?.orgId ?? null;
  } catch {
    return null;
  }
}

// -- Call creation -------------------------------------------------------------------------

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const b64urlJson = (v: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(v)));

/** A public-scope token for POST /call/web: HS256, signed with the private key, valid for a minute. */
async function signPublicJwt(config: VapiConfig, ttlSeconds = 60): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({
    orgId: config.orgId,
    token: { tag: "public", restrictions: { enabled: true, allowTransientAssistant: true } },
    iat: now,
    exp: now + ttlSeconds,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.privateKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

export async function createWebCall(config: VapiConfig, assistant: unknown): Promise<VoiceJoin> {
  const jwt = await signPublicJwt(config);
  const res = await fetch(`${VAPI}/call/web`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ assistant, roomDeleteOnUserLeaveEnabled: true }),
  });
  if (!res.ok) {
    throw new Error(`Vapi could not start the call (${res.status}).`);
  }
  const call = (await res.json()) as {
    id: string;
    webCallUrl?: string;
    transport?: { callUrl?: string; callToken?: string };
    monitor?: { controlUrl?: string };
  };
  const webCallUrl = call.webCallUrl ?? call.transport?.callUrl;
  if (!webCallUrl) throw new Error("Vapi returned no web call URL");
  return {
    callId: call.id,
    webCallUrl,
    ...(call.transport?.callToken ? { callToken: call.transport.callToken } : {}),
    // Kept on the server (the caller strips it before answering the browser): with it the
    // Worker can make Ava speak mid-call, when Onboarded reports a form done.
    ...(call.monitor?.controlUrl ? { controlUrl: call.monitor.controlUrl } : {}),
  };
}

/**
 * Vapi's live call control: makes Ava say exact words on a call that is under way, and
 * leaves a note in her conversation so she knows what happened. Used by Agent 2 when
 * Onboarded reports a form done while she waits on the line. Never throws.
 */
export async function sayOnCall(controlUrl: string, words: string, note: string | null, endAfter = false): Promise<number> {
  const post = (body: unknown) =>
    fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // A failed route can take Vapi half a minute to report.
      signal: AbortSignal.timeout(35000),
    });
  try {
    if (note) {
      // Added without asking for a reply: it is context for her next turn.
      await post({ type: "add-message", message: { role: "system", content: note }, triggerResponseEnabled: false });
    }
    const res = await post({ type: "say", content: words, endCallAfterSpoken: endAfter });
    return res.status;
  } catch {
    return 0;
  }
}

// -- Ava -------------------------------------------------------------------------------------

/** One work site the job is open at, as the employer's Onboarded account describes it. */
interface AvaSite {
  /** The work site's name: what get_requirements takes. */
  site: string;
  where: string | null;
}

interface AvaInput {
  agentName: string;
  questions: ScreeningQuestion[];
  employer: string;
  jobTitle: string;
  today: string;
  offeredStart: string;
  sites: AvaSite[];
  /** Where Vapi posts tool calls: `${toolBaseUrl}/api/vapi/tool-calls/${sessionId}`. */
  toolUrl: string;
  toolSecret: string;
}

const siteLine = (s: AvaSite): string =>
  `- ${s.site}${s.where ? ` (${s.where})` : ""}.`;

const systemPrompt = (a: AvaInput): string =>
  [
    `You are ${a.agentName}, an AI interviewer for ${a.employer}. You are interviewing a candidate for the "${a.jobTitle}" job. Learn their name when you ask for their full legal name; never address them as Guest or Candidate. This call is their short screening interview. Today is ${longDay(a.today)} (${a.today}).`,
    "",
    "You have two goals. First, learn whether they fit the job. Second, make sure that if the team accepts them, they can start onboarding for the right site with no surprises. You are an interviewer, not a salesperson: you do not pitch jobs, and you do not discuss pay. If they ask about pay, say the recruiter will confirm it.",
    "Speak like a friendly recruiter on a phone call. Start each reply with a short acknowledgment of two or three words. Keep every reply to one or two short sentences, three when you are explaining paperwork. Never ask two questions in one reply. Never repeat a question you have already asked. If the candidate interrupts you, stop and listen.",
    "When the candidate asks you something, about the job, the sites, the paperwork or the dates, answer it properly first. Then return to where you were. Do not put a question off until later.",
    "",
    "The job is open at these sites. This list is for you: do not read it out. When you ask where they want to work, name the cities only. Do not invent roles or schedules for a site.",
    ...a.sites.map(siteLine),
    "",
    "Cover these topics in this order:",
    '1. Ask "Which city would you want to work in?" Ask this first, naming only the available cities when needed.',
    '2. Ask "What is your full legal name?" Do not ask for an email.',
    `3. Ask question 1 in the visitor's wording or very close to it: ${a.questions[0]?.question}`,
    `4. Ask question 2 in the visitor's wording or very close to it: ${a.questions[1]?.question}`,
    `5. The decision and what follows it, described below. The fixed offered start date is ${longDay(a.offeredStart)} (${a.offeredStart}); do not ask for a start date.`,
    "If an answer is unclear, you may ask one follow-up on that topic. After that, move on.",
    "",
    "Paperwork. What a site requires comes from Onboarded: which forms, what each one is, why it applies, who fills it in and what to have ready. You do not know any of that by heart.",
    "- When the candidate picks a site or changes site, call get_requirements for it. Then say in one sentence how many onboarding forms that site would need after an offer, and that you can go through them whenever they like. Then carry on with the interview.",
    "- When they ask about the paperwork, answer from the result: name the forms, say which are for every hire and which are because of this site or its state. Give detail on a form when they ask for it, one form per reply. If they ask about another site, call get_requirements for that site.",
    "- Say only what a tool result says about forms, rules and deadlines. If they ask something the results do not cover, say the recruiter will confirm it. You do not know employment law; Onboarded does.",
    "- Before an offer, never say the paperwork arrives by text: on this call the forms open on the candidate's own screen once they accept.",
    "",
    "How you speak when you call a tool: a tool that has a bot_say field takes a short holding line there, such as \"Let me pull that up\", and write no other words in that reply. You speak again when the result arrives.",
    "",
    ...afterTheInterview(),
    "",
    "You do not take notes. A note-taker listens to the call and records the answers and the scores, and the recruiter sees them. Never mention notes or scores.",
    "Never ask for a date of birth, a Social Security number, citizenship or immigration status. The onboarding forms collect those after the offer.",
    "",
    "Examples:",
    'Candidate: "Chicago, I think."',
    'You: call get_requirements with work_location "Chicago" and bot_say "Got it, Chicago, one moment". No words outside the tool call.',
    "Result: (the site, its forms, and what each one is)",
    'You: "Okay. That site would have four onboarding forms after an offer, and I can go through them whenever you like. What is your full legal name?"',
  ].join("\n");

/**
 * Agent 2: what Ava does once the interview's topics are covered. The account's rule decides
 * the offer (request_offer), Onboarded creates the hire (start_paperwork), and she stays on
 * the line while the candidate fills in Onboarded's own pages on their screen.
 */
function afterTheInterview(): string[] {
  return [
    "The decision. This call does not end with the interview. When topics 1 to 4 are covered, call request_offer. It takes no bot_say: a holding line is spoken for you, so write no words at all in the reply that calls it, not even an acknowledgment. Do not hint at the outcome before its result arrives.",
    "- If the result starts with OFFER, give the offer exactly as the result words it and ask if they accept.",
    "- Only an answer given after you have said the whole offer counts as accepting it. If they spoke while you were giving the offer, or answered something else, say the offer again in full and ask again.",
    "- If the result starts with REVIEW, thank them, say the team will review this interview and get back to them, ask if they have any questions, and when they have none say \"Thanks for your time.\" and call endCall in the same reply.",
    "- If the result starts with MISSING, ask for what it names, and call request_offer again after they answer.",
    "",
    "The paperwork. When they accept the offer, call start_paperwork. It creates their hire in Onboarded and opens their onboarding forms on their own screen, under this call.",
    "- When its result starts with READY, tell them in two or three short sentences: their forms are on their screen now; their name is already filled in, and they should check it; you are staying on the line and they can ask you about any form. Then stop talking.",
    "- If they decline the offer, thank them, say the recruiter will be in touch, and end the call.",
    "",
    "While they fill in the forms:",
    "- Stay silent. Do not check in, do not fill silences, do not ask if they are still there. They are typing. Speak only when they speak to you, or when a message that starts with [Onboarded] tells you something.",
    "- If what you hear is not a question or a request to you (typing, a mumble, someone else in the room), reply with nothing more than \"I'm here if you need me.\" and only once.",
    "- When they ask about a form or a field, call read_form. Name the form only if they named one: with no name it reads the form on their screen. Answer in one or two sentences, and only from what the result says the form says. If the form does not cover it, say so and say the recruiter can help.",
    "- When they ask which form they are on, what is on their screen, or what comes next, call read_form with no form name. Its result says which form is on their screen and the order of the others. Never answer that from memory: they move between forms without telling you.",
    "- Never tell them which option to choose on a tax or legal form. Read them what the form says and say the choice is theirs.",
    "- Never ask them to say a Social Security number, a date of birth or a bank account number aloud. If they start to, stop them kindly and ask them to type it on the form instead.",
    "- A message that starts with [Onboarded] comes from the system, not the candidate. It is a fact for you to know. Do not read it aloud and do not answer it.",
    "",
    "Pauses. The candidate can pause the call at any point, and an [Onboarded] message tells you when they pause and when they resume. While the call is paused, say nothing. When they resume, welcome them back in a few words. If you were waiting for their answer to a question, ask it again in one sentence. If they are filling in forms, say only that you are still on the line.",
    "",
    'The close. When an [Onboarded] message says all of their forms are done, they have been told so. If they then have questions, answer them. When they have none or say goodbye, say "Thanks for your time." and call endCall in the same reply. Do not say goodbye yourself: the sign-off is spoken for you when the call ends.',
    "",
    'Example: the candidate, with a form open, says "What does head of household mean?"',
    'You: call read_form with no form name and bot_say "Let me look at that form". No words outside the tool call.',
    "Result: (what the form says, and what they have entered so far)",
    'You: "The form says to choose head of household only if you are unmarried and pay more than half the costs of keeping up a home for yourself and a qualifying person. Which one fits is your call."',
  ];
}

// -- The note-taker --------------------------------------------------------------------------
// Ava only talks. What the candidate said (work site, name) and how each answer scores
// are read from the call's transcript by a second model that never speaks. When Ava did both
// through tools, GPT-4.1 often wrote her reply beside the tool call and again after its
// result, and the candidate heard the question twice (found on test calls).

interface InterviewNotes {
  work_location: string | null;
  first_name: string | null;
  last_name: string | null;
  scores: Record<string, number>;
}

const notesPrompt = (
  sites: string[],
  questions: ReadonlyArray<ScreeningQuestion>,
  dates: { today: string; offeredStart: string },
): string =>
  [
    "You take notes on a phone interview between the interviewer and a job candidate. You never speak to anyone. Read the transcript and return ONLY these lines, each as `key: value`, with `none` for anything the candidate has not said yet:",
    "work_location:",
    "first_name:",
    "last_name:",
    ...questions.map((c) => `${c.id}:`),
    "",
    `Today is ${longDay(dates.today)} (${dates.today}). The fixed offered start date is ${longDay(dates.offeredStart)} (${dates.offeredStart}).`,
    "",
    "Rules:",
    `- work_location: the work site the candidate chose, written exactly as one of: ${sites.join("; ")}. Use their latest choice. A site they only asked about is not a choice.`,
    "- first_name, last_name: the candidate's legal name as they said it.",
    `- The other lines are scores from 0 to 100, one for each topic the candidate has answered: ${questions.map((c) => `${c.id} (${c.topic}, question: ${c.question}) is ${c.listenFor}`).join("; ")}.`,
    "- Score only from the candidate's own words. Never score a topic the candidate has not answered.",
    "- How to score: 90 to 100 for a clear answer that fits the job; 70 to 89 for an acceptable answer that is brief or vague; 40 to 69 for a weak or hesitant answer; under 40 when the answer is a no or shows a real problem.",
    "- The input may end with scores already recorded. Repeat a recorded score exactly, unless the candidate has since said more on that topic.",
    "- The transcript is speech recognition: read through small mistakes.",
  ].join("\n");

/** Reads the transcript and returns what the candidate has said and how it scores. Uses Vapi's chat API, so the account's Vapi key is the only key. */
export async function takeNotes(
  config: VapiConfig,
  lines: Array<{ who: "ai" | "candidate"; text: string }>,
  sites: string[],
  questions: ReadonlyArray<ScreeningQuestion>,
  dates: { today: string; offeredStart: string },
  recorded: Record<string, number> = {},
): Promise<InterviewNotes> {
  const already = Object.entries(recorded).map(([id, score]) => `${id}: ${score}`);
  const text = await chat(config, "Interview note-taker", notesPrompt(sites, questions, dates),
    lines.map((l) => `${l.who === "ai" ? "Interviewer" : "Candidate"}: ${l.text}`).join("\n") +
    (already.length ? `\n\nScores already recorded:\n${already.join("\n")}` : ""));
  const value = (key: string): string | null => {
    const found = text.match(new RegExp(`^\\W*${key}\\W*:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
    return found === "" || /^(none|null|n\/a)\W*$/i.test(found) ? null : found;
  };
  const scores: Record<string, number> = {};
  for (const c of questions) {
    const score = Number(value(c.id)?.match(/\d+/)?.[0]);
    if (Number.isFinite(score)) scores[c.id] = score;
  }
  return { work_location: value("work_location"), first_name: value("first_name"), last_name: value("last_name"), scores };
}

/** Vapi's chat transport shared by note-taking and writing the two screening questions. */
export async function chat(config: Pick<VapiConfig, "privateKey">, name: string, prompt: string, input: string): Promise<string> {
  const res = await fetch(`${VAPI}/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.privateKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      assistant: { name, model: { provider: "openai", model: "gpt-4.1", temperature: 0, messages: [{ role: "system", content: prompt }] } },
      input,
    }),
  });
  // Never echo Vapi's raw error: it can contain the assistant and its secret webhook header.
  if (!res.ok) throw new Error(`The Vapi chat call failed (${res.status}).`);
  const body = (await res.json()) as { output?: Array<{ role?: string; content?: string | null }> };
  return (body.output ?? []).map((m) => m.content ?? "").join("\n");
}

/** A tool Ava waits for. bot_say is her holding line (see buildAva). */
const waitedTool = (
  server: { url: string; headers: Record<string, string>; timeoutSeconds: number },
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
  holdingLine: string,
  /**
   * true: Vapi speaks the holding line itself (the tool's request-start message) and the
   * tool has no bot_say. For a tool the model kept doubling: it wrote the line in its reply
   * and again in bot_say, and the candidate heard it twice (3 of 4 test calls).
   */
  spokenByVapi = false,
) => ({
  type: "function",
  async: false,
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: spokenByVapi
        ? properties
        : { ...properties, bot_say: { type: "string", description: `A short holding line and nothing else, for example: "${holdingLine}"` } },
      required: spokenByVapi ? required : [...required, "bot_say"],
    },
  },
  server,
  // Empty on purpose when bot_say is the holding line: without this Vapi adds a filler of its own.
  messages: [{ type: "request-start", content: spokenByVapi ? holdingLine : "" }],
});

/** Agent 2's extra tools: the offer, the hire, and reading the form that is open. */
function paperworkTools(server: { url: string; headers: Record<string, string>; timeoutSeconds: number }) {
  // Creating the hire is several Onboarded calls in a row: give it longer than a lookup.
  const slow = { ...server, timeoutSeconds: 60 };
  return [
    waitedTool(
      slow,
      "request_offer",
      "Ask whether the employer's rule makes this candidate an offer now. Call it once the interview's topics are covered. Returns OFFER with the words to say, REVIEW when the team has to decide, or MISSING with what to ask first. You speak again after the result.",
      {},
      [],
      "Give me a moment while I check with the team.",
      true,
    ),
    waitedTool(
      slow,
      "start_paperwork",
      "After the candidate accepts the offer: create their hire in Onboarded and open their onboarding forms on their screen. Returns READY with the forms, or a problem to tell them about. You speak again after the result.",
      {},
      [],
      "Great, let me get your paperwork ready",
    ),
    waitedTool(
      server,
      "read_form",
      "Read the onboarding form the candidate is filling in: which form is on their screen now, what each page says, the choices on it, and what they have entered so far (never sensitive values). Call it when they ask about a form or a field, or which form they are on.",
      { form: { type: "string", description: "The form they asked about, if they named it (\"W-4\", \"I-9\"). Leave empty for the one they are on." } },
      [],
      "Let me look at that form",
    ),
  ];
}

/** The transient assistant for one call. */
export function buildAva(a: AvaInput) {
  const server = { url: a.toolUrl, headers: { "x-bca-tool-secret": a.toolSecret }, timeoutSeconds: 20 };
  const anyCase = [{ type: "ignore-case", enabled: true }];
  return {
    name: a.agentName,
    firstMessage: `Hi, I'm ${a.agentName}, the AI interviewer for ${a.employer}. This is a short screening for the ${a.jobTitle} job, and if it goes well we can do your new-hire paperwork on this same call. Ready?`,
    firstMessageMode: "assistant-speaks-first",
    // Vapi ends the call at the limit, paused or not. The agent waits on the line while the
    // candidate fills in forms, so silence does not end it sooner.
    maxDurationSeconds: MAX_CALL_SECONDS,
    silenceTimeoutSeconds: MAX_CALL_SECONDS,
    // Typing next to the microphone is not the candidate speaking.
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },
    backgroundSound: "off",
    // The conversation as Vapi's servers hear it goes to the same webhook as the tool calls:
    // the note-taker reads it there (vapiEvents in endpoints/sessions.ts).
    server,
    serverMessages: ["conversation-update", "end-of-call-report", "tool-calls"],
    model: {
      provider: "openai",
      model: "gpt-4.1",
      temperature: 0.3,
      messages: [{ role: "system", content: systemPrompt(a) }],
      tools: [
        {
          // Waited for: what a site requires is Onboarded's to say, so Ava asks before she
          // explains. bot_say is Vapi's reserved argument: Vapi speaks it before the tool runs
          // and takes it out of the arguments, so the holding line is not left to the model's
          // free text, where it has also guessed the answer.
          type: "function",
          async: false,
          function: {
            name: "get_requirements",
            description:
              "Ask Onboarded what a work site requires: the forms, what each one is, why it applies, who fills it in and what to have ready. Call it for the site the candidate picks, and for any other site they ask about. You speak again after the result.",
            parameters: {
              type: "object",
              properties: {
                work_location: { type: "string", description: "The work site's name, as listed in the sites the job is open at" },
                bot_say: { type: "string", description: 'A short holding line and nothing else, for example: "Let me pull that up"' },
              },
              required: ["work_location", "bot_say"],
            },
          },
          server,
          // Empty on purpose: bot_say is the holding line, and without this Vapi adds a filler of its own.
          messages: [{ type: "request-start", content: "" }],
        },
        ...paperworkTools(server),
        { type: "endCall" },
      ],
    },
    voice: { provider: "vapi", voiceId: "Clara", version: 2 },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    // Turn-taking: quick after a short answer, patient while the candidate thinks.
    //   - After a yes/no question Ava replies 0.6 s after the candidate stops.
    //   - After the legal-name question she allows 1.5 s, for the pause between names.
    //   - After anything else LiveKit's model estimates how likely the candidate is still
    //     talking (x, 0 to 1): 0.8 s when they sound finished, 2.8 s mid-thought.
    // A rule that matches Ava's last words replaces the smart plan for that turn. Her reply
    // takes about another second to start (model, then voice). With no plan at all Vapi
    // replies 0.1 s after any punctuated transcript and cuts into every pause. If Ava does
    // start too early, the candidate keeps talking and she stops (stopSpeakingPlan), and the
    // note-taker reads the whole answer either way.
    startSpeakingPlan: {
      waitSeconds: 0.1,
      smartEndpointingPlan: { provider: "livekit", waitFunction: "800 + 2000 * x" },
      customEndpointingRules: [
        { type: "assistant", regex: "legal name", regexOptions: anyCase, timeoutSeconds: 1.5 },
        { type: "assistant", regex: "ready\\?|(?:does that )?work for you|instead\\?|go through|want (me to|detail)|any (other )?questions|which (site|city|one)|want to work|do you accept", regexOptions: anyCase, timeoutSeconds: 0.6 },
      ],
    },
    // The candidate can interrupt Ava at any point: a third of a second of their voice stops her.
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.3, backoffSeconds: 1 },
    endCallMessage: "Take care. Goodbye.",
    clientMessages: [
      "transcript",
      "speech-update",
      "status-update",
      // Not "tool-calls": that message can carry a tool's own configuration, and with it the
      // session's secret header, into the candidate's browser. The page only needs the results.
      "tool-calls-result",
      "user-interrupted",
    ],
    artifactPlan: { recordingEnabled: true, transcriptPlan: { enabled: true } },
  };
}
