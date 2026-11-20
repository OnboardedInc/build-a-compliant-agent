// AI interview sessions ("Interview Studio"). Plain Hono routes behind the auth
// middleware, except the Vapi tool webhook, which Vapi calls with the
// session's own secret.
//
// One session row holds four JSON columns, each with one kind of writer, so a
// live call's tool webhook and the browser never overwrite each other:
//   base        set once at creation (candidate, job, dates)
//   work        facts, scores, the last check, the account context
//   transcript  appended line by line
//   hire        the placement and its task rows, once the offer is approved
//   api_log     every call to Onboarded and Vapi, appended as they happen

import type { AppContext as Context } from "../index";
import type { Brand, ScreeningQuestion } from "../../shared/builder";
import { builderOf } from "./builders";
import { secretMatches, redactData, publicUrl } from "../services/security";
import { nanoid } from "nanoid";
import {
  FIT_THRESHOLD,
  localToday,
  offeredStartFrom,
  scoreOf,
  longDay,
  shortDay,
  type CandidateInterview,
  type CandidateFormApp,
  type Journey,
  type JourneyStage,
  type JourneyStep,
  type ApiCall,
  type Criterion,
  type FactKey,
  type Facts,
  type InterviewEvents,
  type InterviewSession,
  type InterviewStatus,
  type RequirementsCheck,
  type TranscriptLine,
} from "../../shared/interview";
import {
  computeCheck,
  createHire,
  hireStatusOf,
  loadQuestions,
  refreshHire,
  newCounter,
  requirementsForAva,
  agentFormsOf,
  previewFormsOf,
  readFormForAva,
  taskInHand,
  type AccountContext,
  type CallCounter,
  type HireRecord,
  type OnboardedConfig,
} from "../services/interview";
import { getConfig, createOnboardedEmployee } from "../services/onboarded";
import {
  FORM_APP_MIME,
  FORM_APP_URI,
  MCP_PROTOCOL,
  formAppHtml,
  formAppMeta,
  formAppResource,
  mcpTools,
  type FormAppContent,
} from "../services/onboardedMcp";
import {
  buildAva,
  createWebCall,
  sayOnCall,
  getVapiConfig,
  takeNotes,
  type VapiEnv,
} from "../services/vapi";

interface Base {
  company: string;
  jobTitle: string;
  agentName: string;
  agentFace: number;
  brand: Brand;
  questions: ScreeningQuestion[];
  candidate: { first: string; last: string; email: string };
  today: string;
  offeredStart: string;
}

interface Work {
  facts: Facts;
  scores: Record<string, number>;
  check: RequirementsCheck | null;
  ctx: AccountContext;
  /** How much the candidate had said (characters) when the note-taker last read the call. */
  noted?: number;
  /** For each scored topic, how many times the candidate had spoken when it was first scored. */
  scoredAt?: Record<string, number>;
  /** Agent 2: what the account's rule decided when Ava asked, and whether the candidate accepted. */
  offer?: { state: "offered" | "accepting" | "accepted" | "review"; at: string; score: number };
  /** Agent 2: how many of the candidate's forms Ava has said are done (so she says each once). */
  spoke?: number;
  /** Agent 2: the tasks she has said are done, to name the one that is new. */
  spokeOf?: string[];
}

interface CallState {
  startedAt: string | null;
  endedAt: string | null;
  seconds: number;
  vapiCallId: string | null;
  /** Vapi's control URL for the call: the Worker makes Ava speak through it (Agent 2). Server only. */
  controlUrl?: string | null;
}

interface Row {
  id: string;
  builder_id: string;
  status: InterviewStatus;
  tool_secret: string;
  base: string;
  work: string;
  transcript: string;
  hire: string | null;
  call: string;
  api_log: string;
  error: string | null;
  link_token: string;
  updated_at: string;
}

const db = (c: Context): D1Database => (c.env as { DB: D1Database }).DB;
const ownerOf = (c: Context): string => builderOf(c).id;
const now = (): string => new Date().toISOString();

const readRow = (database: D1Database, id: string, builderId?: string) =>
  builderId === undefined
    ? database.prepare("SELECT * FROM interview_sessions WHERE id = ?").bind(id).first<Row>()
    : database
        .prepare("SELECT * FROM interview_sessions WHERE id = ? AND builder_id = ?")
        .bind(id, builderId)
        .first<Row>();

const readByToken = (database: D1Database, token: string) =>
  database.prepare("SELECT * FROM interview_sessions WHERE link_token = ?").bind(token).first<Row>();

const parse = <T>(json: string | null, fallback: T): T => {
  if (json === null || json === "") return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

const initials = (first: string, last: string): string =>
  `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();

/** Transcript lines in order, one per id (a retried post does not repeat a line). */
const linesOf = (json: string): TranscriptLine[] => {
  const seen = new Set<string>();
  return parse<TranscriptLine[]>(json, [])
    .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
    .sort((a, b) => a.at - b.at);
};

/** The topics this session scores are frozen with the builder's two questions. */
const criteriaOf = (row: { base: string }) => parse<Base>(row.base, {} as Base).questions.map((q) => ({ id: q.id, label: q.topic }));

/** Agent 2's path from the screening to ready for work, from what the session already holds. */
/** What the watch view calls the candidate before the call has given a name. */
const UNNAMED = "The candidate";

function journeyOf(row: Row, work: Work, hire: HireRecord | null, named: string): Journey {
  const first = named || UNNAMED;
  const employer = work.ctx.employerName;
  const forms = hire
    ? agentFormsOf(hire, work.ctx, { first, employer })
    : previewFormsOf(work.check, work.ctx, { first, employer }, work.facts.start_date ?? null);
  const mineTasks = (hire?.tasks ?? []).filter((t) => t.mine);
  const mine = { done: mineTasks.filter((t) => t.mineDone).length, total: mineTasks.length };
  const offered = work.offer?.state === "accepting" ? "offered" : work.offer?.state;
  const offer: Journey["offer"] = hire ? "accepted" : (offered ?? "none");
  const placementDone = forms.filter((f) => f.state === "done").length;
  // Only some accounts' forms have a part for the employer. Nothing here may promise one that is not there.
  const employerPart = forms.some((f) => work.ctx.forms[f.formId]?.sections.some((x) => x.side === "employer"));
  const theirs = employerPart ? `, ${employer}'s part included` : "";
  const ready = hire?.readyAt != null;
  const stage: JourneyStage = !hire
    ? offer === "none" ? "screen" : "offer"
    : ready ? "ready" : "forms";
  const scored = Object.keys(work.scores ?? {}).length;
  const startDay = hire?.startDate ?? work.facts.start_date ?? null;
  const steps: JourneyStep[] = [
    {
      id: "screen",
      label: "1. Screen",
      state: offer === "none" && !hire ? "now" : "done",
      detail:
        offer === "none" && !hire
          ? row.status === "idle"
            ? "Waiting for the candidate to start the call"
            : `${scored} of ${criteriaOf(row).length} topics scored`
          : `Done, score ${scoreOf(criteriaOf(row).map((k) => ({ ...k, score: work.scores?.[k.id] ?? null })))}`,
    },
    {
      id: "offer",
      label: "2. Offer",
      state: hire ? "done" : offer === "none" ? "todo" : "now",
      detail: hire
        ? `Made by the account's rule (score at least ${FIT_THRESHOLD}) and accepted on the call`
        : offer === "offered"
          ? `Offered by the account's rule (score ${work.offer?.score ?? 0}, at least ${FIT_THRESHOLD}). Waiting for the answer.`
          : offer === "review"
            ? `Score ${work.offer?.score ?? 0} is under ${FIT_THRESHOLD}: the team decides`
            : `Made on the call when the score reaches ${FIT_THRESHOLD}`,
    },
    {
      id: "forms",
      label: "3. Forms",
      state: !hire ? "todo" : mine.total > 0 && mine.done === mine.total ? "done" : "now",
      detail: hire
        ? `${first} has done ${mine.done} of ${mine.total}. Placement: ${placementDone} of ${forms.length} complete.`
        : "Onboarded's hosted forms, on the candidate's screen during the call",
    },
    {
      id: "ready",
      label: "4. Ready for work",
      state: ready ? "done" : hire && mine.total > 0 && mine.done === mine.total ? "now" : "todo",
      detail: ready
        ? "Every form on the placement is complete"
        : startDay
          ? `When every form due before ${shortDay(startDay).split(", ")[1] ?? startDay} is done${theirs}`
          : `When every form is done${theirs}`,
    },
  ];
  return {
    stage,
    steps,
    offer,
    forms,
    mine,
    employerPart,
  };
}

/** The employer's I-9 Section 2 link goes to the browser only when SHOW_EMPLOYER_LINK is "1". */
const employerLinkOn = (c: Context): boolean => c.env.SHOW_EMPLOYER_LINK === "1";

function viewOf(row: Row, showEmployerLink = false): InterviewSession {
  const base = parse<Base>(row.base, {} as Base);
  const work = parse<Work>(row.work, {} as Work);
  const call = parse<CallState>(row.call, { startedAt: null, endedAt: null, seconds: 0, vapiCallId: null });
  const hire = parse<HireRecord | null>(row.hire, null);
  const transcript = linesOf(row.transcript);
  const criteria: Criterion[] = criteriaOf(row).map((c) => ({ ...c, score: work.scores?.[c.id] ?? null }));
  // Empty until the candidate has said their name: the Onboarded employee's placeholder name is never shown.
  const first = work.facts?.first_name ?? "";

  return redactData({
    id: row.id,
    journey: journeyOf(row, work, hire, first),
    status: row.status,
    candidate: {
      first,
      last: work.facts?.last_name ?? "",
      email: base.candidate.email,
      initials: initials(first, work.facts?.last_name ?? base.candidate.last),
    },
    job: {
      title: base.jobTitle,
      employer: work.ctx.employerName,
      threshold: FIT_THRESHOLD,
    },
    today: base.today,
    offeredStart: base.offeredStart,
    questions: work.ctx.questions,
    facts: work.facts ?? {},
    transcript,
    criteria,
    score: scoreOf(criteria),
    check: work.check,
    hire: hire ? { ...hireStatusOf(hire), employerUrl: showEmployerLink ? hire.employerUrl : null } : null,
    callSeconds: call.seconds,
    error: row.error,
    api: parse<ApiCall[]>(row.api_log, []).slice(-80),
    linkToken: row.link_token,
    agentName: base.agentName,
    agentFace: base.agentFace,
    company: base.company,
    brand: base.brand,
  }, [row.tool_secret, call.controlUrl]);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Appends calls to the session's API log, one atomic insert per call. */
async function appendApi(database: D1Database, id: string, calls: ApiCall[]): Promise<void> {
  if (calls.length === 0) return;
  const row = await readRow(database, id);
  const builder = row ? await database.prepare("SELECT token FROM builders WHERE id = ?").bind(row.builder_id).first<{ token: string }>() : null;
  const secrets = [row?.tool_secret, parse<CallState>(row?.call ?? null, {} as CallState).controlUrl, builder?.token];
  await database.batch(
    calls.map((call) =>
      database
        .prepare("UPDATE interview_sessions SET api_log = json_insert(api_log, '$[#]', json(?)) WHERE id = ?")
        .bind(JSON.stringify(redactData(call, secrets)), id),
    ),
  );
}

/** A call that is not to Onboarded (Vapi), for the same log. */
const vapiCall = (
  direction: "out" | "in",
  path: string,
  detail: string | null,
  sent: string[],
  status: number,
  returned: string[],
  result: string | null,
  started: number,
): ApiCall => ({
  id: `${started}-vapi-${Math.random().toString(36).slice(2, 7)}`,
  at: new Date(started).toISOString(),
  service: "vapi",
  direction,
  method: "POST",
  path,
  detail,
  sent,
  status,
  returned,
  result,
  ms: Date.now() - started,
});

// -- Create ----------------------------------------------------------------------------------

/** How many sessions one builder can make in 24 hours. */
/** Test calls one agent can start in a day. Each one is a voice call and an employee in the shared Onboarded account. */
const MAX_SESSIONS_PER_DAY = 10;

/** Creates the Onboarded employee directly; the session is a frozen copy of the builder. */
export async function createInterview(c: Context) {
  const builder = builderOf(c);
  if (!builder.verified_at) return c.json({ error: "Confirm your email first." }, 403);
  if (!builder.built_at) return c.json({ error: "Build your agent first." }, 403);
  const body = await c.req.json<{ today?: string }>().catch(() => ({} as { today?: string }));
  // The browser's day, when it is within a day of the server's (time zones): never a date of
  // the caller's choosing, because the start date and the form deadlines are counted from it.
  const serverDay = localToday();
  const near = (day: string): boolean => Math.abs(Date.parse(`${day}T00:00:00Z`) - Date.parse(`${serverDay}T00:00:00Z`)) <= 86_400_000;
  const today = validDay(body?.today) && near(body.today as string) ? (body.today as string) : serverDay;
  // Each session creates an employee in the one Onboarded account every visitor shares.
  const made = await db(c).prepare("SELECT COUNT(*) AS n FROM interview_sessions WHERE builder_id = ? AND created_at > ?").bind(builder.id, new Date(Date.now() - 86_400_000).toISOString()).first<{ n: number }>();
  if ((made?.n ?? 0) >= MAX_SESSIONS_PER_DAY) return c.json({ error: "That is a lot of test calls for one day. Try again tomorrow." }, 429);
  const config = getConfig(c.env);
  if (!config) return c.json({ error: "Onboarded is not configured." }, 502);
  try {
    const database = db(c);
    const id = `int_${nanoid(12)}`;
    const counter = newCounter();
    const candidate = { first: "Guest", last: "Candidate", email: `candidate+${id}@example.com` };
    const employeeId = await createOnboardedEmployee(config, counter, candidate);
    const { questions, sites } = await loadQuestions(config, counter);
    const ctx: AccountContext = {
      employerId: c.env.ONBOARDED_EMPLOYER_ID?.trim() || null,
      employerName: builder.company,
      jobId: c.env.ONBOARDED_JOB_ID?.trim() || null,
      employeeId, sites, questions, forms: {},
    };
    const base: Base = {
      company: builder.company, jobTitle: builder.job_title || "the role",
      agentName: builder.agent_name!, agentFace: builder.agent_face!,
      brand: parse<Brand>(builder.brand, {} as Brand),
      questions: parse<ScreeningQuestion[]>(builder.questions, []), candidate,
      today, offeredStart: offeredStartFrom(today),
    };
    const facts: Facts = { start_date: base.offeredStart };
    // The first preview already has the fixed offered start date.
    const first = () => computeCheck(config, ctx, { facts, today, candidateFirst: UNNAMED, previous: null, latest: null }, counter);
    const check = await first().catch((e: unknown) => {
      // A job from another account must not prevent the interview.
      if (ctx.jobId === null || !/job not found/i.test(messageOf(e))) throw e;
      ctx.jobId = null;
      return first();
    });
    const work: Work = { facts, scores: {}, check, ctx };
    const at = now();
    await database.prepare(`INSERT INTO interview_sessions
      (id, builder_id, status, tool_secret, link_token, base, work, transcript, call, api_log, created_at, updated_at)
      VALUES (?, ?, 'idle', ?, ?, ?, ?, '[]', ?, ?, ?, ?)`)
      .bind(id, builder.id, nanoid(32), nanoid(32), JSON.stringify(base), JSON.stringify(work),
        JSON.stringify({ startedAt: null, endedAt: null, seconds: 0, vapiCallId: null } satisfies CallState),
        JSON.stringify(counter.calls), at, at).run();
    return c.json(viewOf((await readRow(database, id))!, employerLinkOn(c)), 201);
  } catch (e) { return c.json({ error: messageOf(e) }, 502); }
}

const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export async function latestInterview(c: Context) {
  const row = await db(c).prepare("SELECT * FROM interview_sessions WHERE builder_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(ownerOf(c)).first<Row>();
  if (!row) return c.json({ error: "Interview not found" }, 404);
  // A session that never started keeps the start date of the day it was made. After a day it
  // is left behind, so the app makes a fresh one with a start date that is still ahead.
  const madeOn = parse<Base>(row.base, {} as Base).today;
  if (row.status === "idle" && madeOn && Date.parse(`${localToday()}T00:00:00Z`) - Date.parse(`${madeOn}T00:00:00Z`) > 86_400_000) {
    return c.json({ error: "Interview not found" }, 404);
  }
  return c.json(viewOf(await followHire(c, row), employerLinkOn(c)));
}

// -- Read ------------------------------------------------------------------------------------

export async function getInterview(c: Context) {
  const database = db(c);
  const builderId = ownerOf(c);
  let row = await readRow(database, c.req.param("id") ?? "", builderId);
  if (!row) return c.json({ error: "Interview not found" }, 404);

  // After the offer, each read follows the hire's tasks in Onboarded.
  row = await followHire(c, row);
  return c.json(viewOf(row, employerLinkOn(c)));
}

/**
 * Follows a hire's tasks in Onboarded (at most one read every 1.5 s).
 * Ava says when one of the candidate's forms is done. Both pages poll, so the
 * announcement is claimed in the database before it is made.
 */
async function followHire(c: Context, row: Row): Promise<Row> {
  const database = db(c);
  const hire = parse<HireRecord | null>(row.hire, null);
  if (!hire) return row;
  const base = parse<Base>(row.base, {} as Base);
  const work = parse<Work>(row.work, {} as Work);
  const config = await getConfig(c.env);
  if (!config) return row;
  try {
    const formOrder = [...new Set((work.check?.steps ?? []).map((s) => s.formId))];
    const counter = newCounter();
    const next = hire.readyAt === null ? await refreshHire(config, work.ctx, hire, formOrder, false, counter) : hire;
    if (next !== hire) {
      await appendApi(database, row.id, counter.calls);
      await database
        .prepare("UPDATE interview_sessions SET hire = ?, error = NULL, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(next), now(), row.id)
        .run();
      row = { ...((await readRow(database, row.id)) ?? row), hire: JSON.stringify(next), error: null };
    }
    await speakOfProgress(c, row, next, work, base);
    row = (await readRow(database, row.id)) ?? row;
  } catch (e) {
    row = { ...row, error: messageOf(e) };
  }
  return row;
}

/** Agent 2: when one more of the candidate's forms is done, Ava says so on the call, once. */
async function speakOfProgress(c: Context, row: Row, hire: HireRecord, work: Work, base: Base): Promise<void> {
  const database = db(c);
  const mine = (hire.tasks ?? []).filter((t) => t.mine);
  const done = mine.filter((t) => t.mineDone);
  if (mine.length === 0 || done.length === 0 || done.length <= (work.spoke ?? 0)) return;
  // Claim it: the candidate's page and the watch view both get here.
  const claimed = await database
    .prepare(
      `UPDATE interview_sessions SET work = json_set(work, '$.spoke', ?)
       WHERE id = ? AND COALESCE(json_extract(work, '$.spoke'), 0) < ?`,
    )
    .bind(done.length, row.id, done.length)
    .run();
  if (!claimed.meta.changes) return;
  const call = parse<CallState>(row.call, { startedAt: null, endedAt: null, seconds: 0, vapiCallId: null });
  if (!call.controlUrl || row.status !== "live") return; // the call is over: nothing to say it on
  const first = work.facts.first_name ?? "";
  const employer = work.ctx.employerName;
  const left = mine.length - done.length;
  // The forms finished since she last spoke, by name.
  // Names as a voice says them: "W-4" is read out as "W minus 4", so the hyphen goes.
  const fresh = done.filter((t) => !(work.spokeOf ?? []).includes(t.id)).map((t) => t.name.replace(/-/g, " "));
  await database
    .prepare("UPDATE interview_sessions SET work = json_set(work, '$.spokeOf', json(?)) WHERE id = ?")
    .bind(JSON.stringify(done.map((t) => t.id)), row.id)
    .run();
  const latest = fresh.length === 0 ? "that form" : fresh.length === 1 ? fresh[0] : `${fresh.slice(0, -1).join(", ")} and ${fresh.at(-1)}`;
  const allDone = left === 0;
  // The employer has steps of its own only when a form has a part for them and it is still open.
  const theirsOpen = (hire.tasks ?? []).some((t) => t.status !== "completed" && (work.ctx.forms[t.formId]?.sections.some((x) => x.side === "employer") ?? false));
  const words = allDone
    ? theirsOpen
      ? `That's the last one${first ? `, ${first}` : ""}. You're all set for now. ${employer} confirms your start once it has finished its own steps. Any questions before we hang up?`
      : `That's the last one${first ? `, ${first}` : ""}. You're all set. ${employer} will confirm your start. Any questions before we hang up?`
    : `Got it, your ${latest} ${fresh.length > 1 ? "are" : "is"} in. ${left === 1 ? "One more to go." : `${left} more to go.`}`;
  const note = allDone
    ? `[Onboarded] All ${mine.length} of the candidate's forms are done, and they have just been told so. ${theirsOpen ? `${employer} still has its own steps. ` : "Nothing more is needed from them. "}Answer any questions, then close the call.`
    : `[Onboarded] The candidate finished ${latest}. ${done.length} of their ${mine.length} forms are done. They have just been told. Keep waiting silently.`;
  const started = Date.now();
  const controlUrl = call.controlUrl;
  // Spoken behind the response: Vapi can take half a minute to refuse a dead call, and the
  // page that triggered this is waiting for its read.
  const speak = (async () => {
    const status = await sayOnCall(controlUrl, words, note);
    await appendApi(database, row.id, [
      vapiCall(
        "out",
        "call control: say",
        "Onboarded reports a form done, so the agent says it on the call. It was silent until then.",
        [`type: say`, `content: ${words.slice(0, 90)}`],
        status,
        [status === 200 ? "status: ok" : `status: ${status}`],
        allDone ? "all of the candidate's forms are done" : `${done.length} of ${mine.length} done`,
        started,
      ),
    ]);
  })().catch(() => console.error("Call control failed"));
  try {
    c.executionCtx.waitUntil(speak);
  } catch {
    await speak; // no execution context (a test harness)
  }
}

const FACT_KEYS: ReadonlyArray<FactKey> = ["first_name", "last_name", "work_location"];

/** Merges new facts and scores into the session and re-runs Onboarded's check when a fact changed. */
async function applyFacts(
  database: D1Database,
  config: OnboardedConfig,
  row: Row,
  facts: Facts,
  scores: Record<string, number>,
  /** When given, the Onboarded calls are returned here instead of logged, for the caller to log in its own order. */
  held?: ApiCall[],
): Promise<{ work: Work; error: string | null }> {
  const base = parse<Base>(row.base, {} as Base);
  const work = parse<Work>(row.work, {} as Work);
  let latest: FactKey | null = null;
  // Only what changes is written back (see the UPDATE below): Ava's tool call and the
  // note-taker can both be at work on the same row, each from its own read of it.
  const changed: Array<[path: string, value: string | number]> = [];
  for (const key of FACT_KEYS) {
    const value = facts[key];
    if (value === undefined || value === "" || work.facts[key] === value) continue;
    work.facts[key] = value;
    changed.push([`$.facts.${key}`, value]);
    latest = key;
  }
  for (const [criterion, score] of Object.entries(scores)) {
    if (criteriaOf(row).some((k) => k.id === criterion) && Number.isFinite(score)) {
      work.scores[criterion] = Math.max(0, Math.min(100, Math.round(score)));
      changed.push([`$.scores.${criterion}`, work.scores[criterion]]);
    }
  }
  let error: string | null = null;
  if (latest !== null) {
    const counter = newCounter();
    try {
      work.check = await computeCheck(
        config,
        work.ctx,
        {
          facts: work.facts,
          today: base.today,
          candidateFirst: work.facts.first_name ?? UNNAMED,
          previous: work.check,
          latest,
        },
        counter,
      );
    } catch (e) {
      // A failed preview keeps the card's last result.
      error = messageOf(e);
    }
    if (held) held.push(...counter.calls);
    else await appendApi(database, row.id, counter.calls);
  }
  // A check also loads the forms it met into the session's copy of the account (ctx.forms).
  const checked = latest !== null && error === null;
  await database
    .prepare(
      `UPDATE interview_sessions SET work = json_set(work${changed.map(() => ", ?, ?").join("")}${checked ? ", '$.check', json(?), '$.ctx.forms', json(?)" : ""}), error = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(...changed.flat(), ...(checked ? [JSON.stringify(work.check), JSON.stringify(work.ctx.forms)] : []), error, now(), row.id)
    .run();
  return { work, error };
}

async function appendLines(database: D1Database, id: string, lines: TranscriptLine[]): Promise<void> {
  for (const line of lines) {
    if (typeof line?.id !== "string" || typeof line.text !== "string" || (line.who !== "ai" && line.who !== "candidate")) continue;
    const clean: TranscriptLine = {
      id: line.id.slice(0, 80),
      at: Number(line.at) || 0,
      who: line.who === "ai" ? "ai" : "candidate",
      text: line.text.slice(0, 2000),
    };
    await database
      .prepare("UPDATE interview_sessions SET transcript = json_insert(transcript, '$[#]', json(?)) WHERE id = ?")
      .bind(JSON.stringify(clean), id)
      .run();
  }
}

/** Transcript lines and the call's start and end: what either side of a call may report. */
async function recordCall(database: D1Database, row: Row, body: InterviewEvents): Promise<void> {
  if (body.lines?.length) await appendLines(database, row.id, body.lines);
  if (body.call !== undefined || body.callSeconds !== undefined) {
    const call = parse<CallState>(row.call, { startedAt: null, endedAt: null, seconds: 0, vapiCallId: null });
    if (body.call === "start" && call.startedAt === null) call.startedAt = now();
    if (body.call === "end") call.endedAt = now();
    if (typeof body.callSeconds === "number") call.seconds = Math.max(0, Math.round(body.callSeconds));
    // Agent 2 hires on the call: when that call ends the interview is already approved.
    const status: InterviewStatus =
      body.call === "start" ? "live" : body.call === "end" ? (row.hire ? "approved" : "ended") : row.status;
    await database
      .prepare("UPDATE interview_sessions SET call = ?, status = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(call), status, now(), row.id)
      .run();
  }
}

const setStatus = (database: D1Database, id: string, status: InterviewStatus, error: string | null = null) =>
  database
    .prepare("UPDATE interview_sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?")
    .bind(status, error, now(), id)
    .run();

export async function approveInterview(c: Context) {
  const database = db(c);
  const builderId = ownerOf(c);
  const row = await readRow(database, c.req.param("id") ?? "", builderId);
  if (!row) return c.json({ error: "Interview not found" }, 404);
  // Agent 2 may already have hired on the call: never make a second placement.
  if (row.status === "approved" || row.hire) return c.json(viewOf(row, employerLinkOn(c)));
  // While the call is under way the decision is the call's: approving now would cut
  // the candidate's page off from it.
  if (row.status === "live") {
    return c.json({ error: "The call is still under way. Approve the offer once it has ended." }, 409);
  }
  // Approve is the offer after a call that ended without one (the score was under the
  // threshold) or with one left unanswered. It never makes a hire for a call that did not happen.
  const offered = parse<Work>(row.work, {} as Work).offer?.state;
  if (row.status === "idle" || (offered !== "review" && offered !== "offered")) {
    return c.json({ error: "Approve is for a call that ended without a hire." }, 409);
  }
  const config = await getConfig(c.env);
  if (!config) return c.json({ error: "Onboarded is not connected" }, 400);

  // Claimed first: a second click, or a second recruiter, must not make a second placement.
  const claimed = await database
    .prepare(
      "UPDATE interview_sessions SET status = 'approving', error = NULL, updated_at = ? WHERE id = ? AND hire IS NULL AND status NOT IN ('approving', 'approved', 'live', 'idle') AND json_extract(work, '$.offer.state') IN ('review', 'offered')",
    )
    .bind(now(), row.id)
    .run();
  if (!claimed.meta.changes) return c.json(viewOf((await readRow(database, row.id)) as Row, employerLinkOn(c)));
  const counter: CallCounter = newCounter();
  try {
    await hireFor(database, row, config, counter, "approved");
  } catch (e) {
    await setStatus(database, row.id, "review", messageOf(e));
  }
  await appendApi(database, row.id, counter.calls);
  return c.json(viewOf((await readRow(database, row.id)) as Row, employerLinkOn(c)));
}

/**
 * Creates the hire in Onboarded (employee update, placement with its tasks, due dates, the
 * hosted link) and records it on the session. The recruiter's Approve
 * and Agent 2's start_paperwork both end here.
 */
async function hireFor(
  database: D1Database,
  row: Row,
  config: OnboardedConfig,
  counter: CallCounter,
  /** "approved" for the recruiter's Approve. null for a hire made on a call: the call's own status stands. */
  status: "approved" | null,
): Promise<HireRecord> {
  const work = parse<Work>(row.work, {} as Work);
  const formOrder = [...new Set((work.check?.steps ?? []).map((s) => s.formId))];
  const hire = await createHire(
    config,
    work.ctx,
    // Agent 2 shows the hosted page during the call and has to know which form is on screen.
    { facts: work.facts, formOrder },
    counter,
  );
  const at = now();
  await database.batch([
    database
      .prepare(
        // Only the account's forms are written back: the note-taker may be writing facts and scores.
        // A hire made on a call leaves the status alone, except that a call which ended while
        // the hire was being created is an approved interview (the status is read here, not
        // carried over from before the Onboarded calls).
        `UPDATE interview_sessions SET status = CASE WHEN ? IS NOT NULL THEN ? WHEN status IN ('ended', 'review') THEN 'approved' ELSE status END,
           hire = ?, work = json_set(work, '$.ctx.forms', json(?)), error = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(status, status, JSON.stringify(hire), JSON.stringify(work.ctx.forms), at, row.id),
  ]);
  return hire;
}

// -- Voice (Vapi) ----------------------------------------------------------------------------------

const vapiEnv = (c: Context): VapiEnv => c.env as VapiEnv;

const TUNNEL_STATUS = "127.0.0.1:20248";

/** Starts the live call: the Worker creates it at Vapi and the browser joins. */
async function callFor(c: Context, row: Row) {
  const database = db(c);
  const vapi = await getVapiConfig(database, vapiEnv(c));
  if (!vapi) {
    return c.json(
      { error: "Configure VAPI_PRIVATE_KEY and, if discovery fails, VAPI_ORG_ID." },
      400,
    );
  }
  const origin = new URL(c.req.url).origin;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(origin);
  const toolBase = vapi.toolBaseUrl ?? (local ? null : origin);
  if (!toolBase) {
    return c.json(
      {
        error:
          "The agent's tool calls come from Vapi's servers, which cannot reach localhost. Stop the app and start it with `npm run dev:voice`: it opens a tunnel and saves its address for you.",
      },
      400,
    );
  }
  // A tunnel address saved by an earlier run may be dead. `npm run dev:voice` runs
  // cloudflared with its status page on a fixed local port: ask it which address is live.
  // (The address itself is not fetched: a lookup made before its DNS exists gets cached as a miss.)
  if (local && new URL(toolBase).hostname.endsWith(".trycloudflare.com")) {
    const live = await fetch(`http://${TUNNEL_STATUS}/quicktunnel`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.json() as Promise<{ hostname?: string }>)
      .then((t) => t.hostname ?? null)
      .catch(() => null);
    if (live !== new URL(toolBase).hostname) {
      return c.json(
        {
          error:
            "The tunnel the agent's tool calls come through is not running. Stop the app and start it with `npm run dev:voice`: it opens the tunnel and saves its address.",
        },
        400,
      );
    }
  }
  const base = parse<Base>(row.base, {} as Base);
  const work = parse<Work>(row.work, {} as Work);
  try {
    const assistant = buildAva({
      agentName: base.agentName,
      questions: base.questions,
      employer: work.ctx.employerName,
      jobTitle: base.jobTitle,
      today: base.today,
      offeredStart: base.offeredStart,
      sites: work.ctx.sites.map((s) => ({
        site: s.label,
        where: [s.city, s.state].filter(Boolean).join(", ") || null,
      })),
      toolUrl: publicUrl(toolBase, c.env.BASE_PATH, `/api/vapi/tool-calls/${row.id}`),
      toolSecret: row.tool_secret,
    });
    const started = Date.now();
    const sent = [
      `assistant.name: ${base.agentName} (built for this call)`,
      "assistant.model: openai gpt-4.1",
      "assistant.tools: get_requirements, request_offer, start_paperwork, read_form, endCall",
      "assistant.serverMessages: conversation-update (the note-taker reads the call from Vapi's servers)",
      `tools.server.url: ${publicUrl(toolBase, c.env.BASE_PATH, "/api/vapi/tool-calls/…").replace(/^https?:\/\//, "")}`,
    ];
    const detail = "Create the voice call. The browser joins it; the key stays on the server.";
    let join;
    try {
      join = await createWebCall(vapi, assistant);
    } catch (e) {
      await appendApi(database, row.id, [
        vapiCall("out", "api.vapi.ai/call/web", detail, sent, 502, [`message: ${messageOf(e).slice(0, 120)}`], "call not created", started),
      ]);
      throw e;
    }
    await appendApi(database, row.id, [
      vapiCall("out", "api.vapi.ai/call/web", detail, sent, 201, [`id: ${join.callId}`, `webCallUrl: ${join.webCallUrl.split("/").slice(0, 3).join("/")}/…`], "call created", started),
    ]);
    const call = parse<CallState>(row.call, { startedAt: null, endedAt: null, seconds: 0, vapiCallId: null });
    call.vapiCallId = join.callId;
    call.controlUrl = join.controlUrl ?? null;
    await database
      .prepare("UPDATE interview_sessions SET call = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(call), now(), row.id)
      .run();
    // The control URL can make Ava say anything: it stays on the server.
    const { controlUrl: _server, ...forBrowser } = join;
    return c.json(forBrowser);
  } catch (e) {
    return c.json({ error: messageOf(e) }, 502);
  }
}

interface VapiToolCall {
  id: string;
  function?: { name?: string; arguments?: unknown };
}

const argsOf = (call: VapiToolCall): Record<string, unknown> => {
  const raw = call.function?.arguments;
  const args =
    typeof raw === "string"
      ? parse<Record<string, unknown>>(raw, {})
      : raw !== null && typeof raw === "object"
        ? { ...(raw as Record<string, unknown>) }
        : {};
  // bot_say is what Ava says as she calls the tool (see buildAva). Vapi speaks it and takes it
  // out of the arguments, except when it is empty. It is never part of the answer.
  delete args.bot_say;
  return args;
};

/** A spoken date or site name as the fact the account expects. */
function factsFromArgs(args: Record<string, unknown>, work: Work): Facts {
  const facts: Facts = {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const first = str(args.first_name);
  const last = str(args.last_name);
  if (first) facts.first_name = first;
  if (last) facts.last_name = last;
  const where = str(args.work_location)?.toLowerCase();
  if (where) {
    const site =
      work.ctx.sites.find((s) => s.id === where || s.label.toLowerCase() === where) ??
      work.ctx.sites.find(
        (s) =>
          s.label.toLowerCase().includes(where) ||
          where.includes(s.label.toLowerCase()) ||
          (s.city !== null && where.includes(s.city.toLowerCase())),
      );
    if (site) facts.work_location = site.id;
  }
  return facts;
}

interface VapiSpoken {
  role?: string;
  content?: unknown;
  message?: unknown;
}
interface VapiEvent {
  message?: {
    call?: { monitor?: { controlUrl?: string } };
    type?: string;
    toolCallList?: VapiToolCall[];
    conversation?: VapiSpoken[];
    messages?: VapiSpoken[];
    messagesOpenAIFormatted?: VapiSpoken[];
    artifact?: { messages?: VapiSpoken[]; messagesOpenAIFormatted?: VapiSpoken[] };
  };
}

/** The conversation in a Vapi event as who said what. Tool calls and the system prompt are left out. */
function conversationOf(event: VapiEvent["message"]): Array<{ who: "ai" | "candidate"; text: string }> {
  // Vapi sends the conversation under several names, and mid-call some of them are empty
  // lists: take the first that has anything in it.
  const list =
    [event?.conversation, event?.messagesOpenAIFormatted, event?.artifact?.messagesOpenAIFormatted, event?.messages, event?.artifact?.messages].find(
      (candidate) => Array.isArray(candidate) && candidate.length > 0,
    ) ?? [];
  const lines: Array<{ who: "ai" | "candidate"; text: string }> = [];
  for (const m of list) {
    const text = typeof m.content === "string" ? m.content : typeof m.message === "string" ? m.message : "";
    const who = m.role === "user" ? "candidate" : m.role === "assistant" || m.role === "bot" ? "ai" : null;
    if (who !== null && text.trim() !== "") lines.push({ who, text: text.trim() });
  }
  return lines;
}

/**
 * The note-taker. Ava only talks; what the candidate said and how it scores is read from the
 * conversation Vapi's servers heard (never from the candidate's browser). It runs each time
 * the candidate has said something new, and once more when the call ends. Every pass reads
 * the whole call, so a pass that is lost or late is made good by the next one.
 */
async function noteTheCall(c: Context, sessionId: string, event: VapiEvent["message"], final: boolean): Promise<void> {
  const database = db(c);
  const lines = conversationOf(event);
  const said = lines.filter((l) => l.who === "candidate").reduce((n, l) => n + l.text.length, 0);
  if (said === 0) return;
  // Vapi sends an update for every change to the conversation, and the candidate's line grows
  // word by word while they speak. Notes are taken once the answer is whole: when Ava has
  // replied to it. The call's last answer is picked up by the end-of-call pass.
  if (!final && lines.at(-1)?.who !== "ai") return;
  // Claim this much of the call, so only one pass runs for each new thing the candidate said.
  const claimed = await database
    .prepare(
      `UPDATE interview_sessions SET work = json_set(work, '$.noted', ?)
       WHERE id = ? AND COALESCE(json_extract(work, '$.noted'), 0) < ?`,
    )
    .bind(said, sessionId, final ? said + 1 : said)
    .run();
  if (!claimed.meta.changes) return;
  const row = await readRow(database, sessionId);
  if (!row) return;
  // Agent 2 keeps talking after the hire (the forms): the interview's notes are closed by then.
  if (row.hire) return;
  const config = await getConfig(c.env);
  const vapi = await getVapiConfig(database, vapiEnv(c));
  if (!config || !vapi) return;
  const started = Date.now();
  const sites = parse<Work>(row.work, {} as Work).ctx.sites;
  const criteria = criteriaOf(row);
  const dates = parse<Base>(row.base, {} as Base);
  const notes = await takeNotes(
    vapi,
    lines,
    sites.map((s) => s.label),
    dates.questions,
    { today: dates.today, offeredStart: dates.offeredStart },
    parse<Work>(row.work, {} as Work).scores,
  );

  // The row may have moved on while the note-taker read: apply to what is there now.
  const current = (await readRow(database, sessionId)) as Row;
  const work = parse<Work>(current.work, {} as Work);
  if (!final && (work.noted ?? 0) > said) return; // a later pass is already on its way
  const wanted = factsFromArgs({ ...notes }, work);
  const facts: Facts = {};
  for (const key of FACT_KEYS) if (wanted[key] !== undefined && wanted[key] !== work.facts[key]) facts[key] = wanted[key];
  // A score is written once. It may be corrected only by the very next thing the candidate
  // says, because an answer is sometimes heard in two pieces. After that it stays, so the
  // recruiter's numbers do not move each time the note-taker reads the call again.
  const scores: Record<string, number> = {};
  const spoke = lines.filter((l) => l.who === "candidate").length;
  const scoredAt = { ...(work.scoredAt ?? {}) };
  for (const { id } of criteria) {
    const score = notes.scores[id];
    if (score === undefined || score === work.scores[id]) continue;
    if (work.scores[id] === undefined) scoredAt[id] = spoke;
    else if (spoke > (scoredAt[id] ?? 0) + 1) continue;
    scores[id] = score;
  }
  if (Object.keys(facts).length === 0 && Object.keys(scores).length === 0) return;

  // Logged as cause, then effect: the note-taker's read first, then the Onboarded calls it set off.
  const behind: ApiCall[] = [];
  await applyFacts(database, config, current, facts, scores, behind);
  await database
    .prepare("UPDATE interview_sessions SET work = json_set(work, '$.scoredAt', json(?)) WHERE id = ?")
    .bind(JSON.stringify(scoredAt), sessionId)
    .run();
  const label = (id: string) => criteria.find((k) => k.id === id)?.label ?? id;
  await appendApi(database, sessionId, [
    vapiCall(
      "out",
      "/chat",
      "The note-taker reads the call so far and writes down what the candidate said. The agent keeps talking.",
      [`transcript: ${lines.length} lines`, `candidate's last words: ${lines.filter((l) => l.who === "candidate").at(-1)?.text.slice(0, 80) ?? ""}`],
      200,
      [
        ...Object.entries(facts).map(([k, v]) => `${k}: ${k === "work_location" ? (sites.find((x) => x.id === v)?.label ?? v) : v}`),
        ...Object.entries(scores).map(([k, v]) => `score, ${label(k)}: ${v}`),
      ],
      [Object.keys(facts).length ? "answer saved" : null, Object.keys(scores).length ? "scored" : null].filter(Boolean).join(", "),
      started,
    ),
    ...behind,
  ]);
}

/**
 * Vapi's webhook for one call. Two kinds of message arrive:
 *   - "tool-calls": the interviewer's waited tools.
 *   - "conversation-update" and "end-of-call-report": the conversation so far, for the note-taker.
 */
export async function vapiToolCalls(c: Context) {
  const database = db(c);
  const row = await readRow(database, c.req.param("id") ?? "");
  if (!row || !(await secretMatches(c.req.header("x-bca-tool-secret"), row.tool_secret))) {
    return c.json({ error: "Unknown session" }, 401);
  }
  const body = await c.req.json<VapiEvent>().catch(() => ({}) as VapiEvent);
  const type = body?.message?.type;
  if (type === "conversation-update" || type === "end-of-call-report") {
    // Answered at once: the notes are taken behind the response.
    const notes = noteTheCall(c, row.id, body.message, type === "end-of-call-report").catch(() =>
      console.error("Note-taker failed"),
    );
    try {
      c.executionCtx.waitUntil(notes);
    } catch {
      await notes; // no execution context (a test harness)
    }
    return c.json({});
  }
  const calls = Array.isArray(body?.message?.toolCallList) ? body.message.toolCallList : [];
  const config = await getConfig(c.env);
  const base = parse<Base>(row.base, {} as Base);
  const results: Array<{ toolCallId: string; result: string }> = [];
  // Vapi also names the call's control URL here: keep it if the call's creation did not.
  const control = body?.message?.call?.monitor?.controlUrl;
  if (control && !parse<CallState>(row.call, {} as CallState).controlUrl) {
    await database.prepare("UPDATE interview_sessions SET call = json_set(call, '$.controlUrl', ?) WHERE id = ?").bind(control, row.id).run();
  }

  for (const call of calls) {
    results.push({ toolCallId: call.id, result: await runTool(c, row.id, config, base, call.function?.name, argsOf(call), body.message) });
  }
  return c.json({ results });
}

/**
 * One tool call, whoever made it: Ava through Vapi's webhook, or an MCP client through the
 * session's MCP endpoint. Returns the words the caller gets back.
 */
async function runTool(
  c: Context,
  rowId: string,
  config: OnboardedConfig | null,
  base: Base,
  name: string | undefined,
  args: Record<string, unknown>,
  /** The Vapi event the call came in, when it came from a call: the note-taker reads the conversation from it. */
  event: VapiEvent["message"] | undefined,
): Promise<string> {
  const database = db(c);
  // Each call reads the row again: the note-taker may have written it.
  const current = (await readRow(database, rowId)) as Row;
  const work = parse<Work>(current.work, {} as Work);
  if (!config) {
    return "Onboarded is not connected.";
  } else if (name === "get_requirements") {
    const started = Date.now();
    // A lookup, not an answer: it reads what a site would need and saves nothing. The
    // candidate's actual choice is written down by the note-taker.
    const asked = factsFromArgs({ work_location: args.work_location }, work).work_location;
    const site = work.ctx.sites.find((s) => s.id === asked);
    const counter = newCounter();
    let answer: string;
    try {
      if (!site) throw new Error(`No work site named "${String(args.work_location)}". The sites are: ${work.ctx.sites.map((s) => s.label).join("; ")}.`);
      const check = await computeCheck(
        config,
        work.ctx,
        { facts: { ...work.facts, work_location: site.id }, today: base.today, candidateFirst: work.facts.first_name ?? UNNAMED, previous: null, latest: "work_location" },
        counter,
      );
      answer = requirementsForAva(check, work.ctx, site);
      // The forms this lookup read are worth keeping for the next one.
      await database
        .prepare("UPDATE interview_sessions SET work = json_set(work, '$.ctx.forms', json(?)) WHERE id = ?")
        .bind(JSON.stringify(work.ctx.forms), rowId)
        .run();
    } catch (e) {
      answer = `UNKNOWN. ${messageOf(e)} Do not list any forms; say the recruiter will confirm what is needed.`;
    }
    await appendApi(database, rowId, [
      vapiCall(
        "in",
        "/api/vapi/tool-calls",
        "The agent asks what this work site requires, and waits for Onboarded's answer before explaining it",
        [`function.name: ${name}`, ...Object.entries(args).map(([k, v]) => `arguments.${k.slice(0, 40)}: ${String(v).slice(0, 300)}`)],
        200,
        answer.split("\n").slice(0, 8).map((line, i) => (i === 0 ? `result: ${line}` : `  ${line.slice(0, 110)}`)),
        site ? `answered: ${site.label}` : "no such site",
        started,
      ),
      ...counter.calls,
    ]);
    return answer;
  } else if (name === "request_offer" || name === "start_paperwork" || name === "read_form") {
    const started = Date.now();
    const behind: ApiCall[] = [];
    let answer: string;
    let outcome: string;
    try {
      if (name === "request_offer") {
        // The scores Ava is asking about include the answer she has just heard: read the call first.
        await noteTheCall(c, rowId, event, true).catch(() => console.error("Note-taker failed"));
        // A note pass for that last answer may also be on its way from the conversation
        // update: give it a few seconds before telling Ava something is missing.
        for (let i = 0; i < 16; i += 1) {
          const w = parse<Work>(((await readRow(database, rowId)) as Row).work, {} as Work);
          if (criteriaOf(current).every((k) => w.scores?.[k.id] !== undefined) && w.facts.start_date && w.facts.work_location) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        [answer, outcome] = await offerFor(database, (await readRow(database, rowId)) as Row);
      } else if (name === "start_paperwork") {
        [answer, outcome] = await paperworkFor(database, (await readRow(database, rowId)) as Row, config, behind);
      } else {
        [answer, outcome] = await formFor(database, current, config, typeof args.form === "string" ? args.form : null, behind);
      }
    } catch (e) {
      answer = `PROBLEM. ${messageOf(e).slice(0, 300)} Tell the candidate there is a technical problem on your side and that the recruiter will follow up. Do not guess.`;
      outcome = "failed";
    }
    const purpose: Record<string, string> = {
      request_offer: "The agent asks whether the rule makes an offer now, and waits for the answer",
      start_paperwork: "The candidate accepted: the agent asks for the hire and its forms, and waits",
      read_form: "The candidate asked about a form: the agent reads it from Onboarded before answering",
    };
    await appendApi(database, rowId, [
      vapiCall(
        "in",
        "/api/vapi/tool-calls",
        purpose[name] ?? null,
        [`function.name: ${name}`, ...Object.entries(args).map(([k, v]) => `arguments.${k.slice(0, 40)}: ${String(v).slice(0, 300)}`)],
        200,
        // For a form read, only its first line (the form's name): the rest can hold the candidate's answers.
        answer.split("\n").slice(0, name === "read_form" ? 1 : 6).map((line, i) => (i === 0 ? `result: ${line.slice(0, 160)}` : `  ${line.slice(0, 110)}`)),
        outcome,
        started,
      ),
      ...behind,
    ]);
    return answer;
  }
  return "Unknown tool.";
}

// -- Agent 2's tools: the offer, the hire, reading a form -----------------------------------------

/** request_offer: the account's rule. An offer when every topic is scored and the score reaches the threshold. */
async function offerFor(database: D1Database, row: Row): Promise<[answer: string, outcome: string]> {
  const base = parse<Base>(row.base, {} as Base);
  const work = parse<Work>(row.work, {} as Work);
  if (row.hire) return ["OFFER. The offer was already accepted and the forms are on their screen. Carry on.", "already hired"];
  const site = work.ctx.sites.find((s) => s.id === work.facts.work_location);
  const criteria = criteriaOf(row);
  const unscored = criteria.filter((k) => work.scores?.[k.id] === undefined).map((k) => k.label.toLowerCase());
  const missing = [
    site ? null : "which work site they want",
    work.facts.start_date ? null : "the fixed start date on file",
    ...unscored.map((label) => `their answer on ${label}`),
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    return [`MISSING. Before a decision you still need: ${missing.join("; ")}. Ask for it, one question at a time, then call request_offer again.`, `missing: ${missing.length}`];
  }
  const score = scoreOf(criteria.map((k) => ({ ...k, score: work.scores?.[k.id] ?? null })));
  // The date is fixed and there is no date-changing tool. Preserve the original deadline
  // guard by sending a failed or risky check to the recruiter, rather than looping on MISSING.
  const needsReview = work.check === null || row.error !== null || !!work.check.risk;
  const state = score >= FIT_THRESHOLD && !needsReview ? "offered" : "review";
  await database
    .prepare("UPDATE interview_sessions SET work = json_set(work, '$.offer', json(?)), updated_at = ? WHERE id = ?")
    .bind(JSON.stringify({ state, at: now(), score }), now(), row.id)
    .run();
  if (state === "review") {
    return [
      "REVIEW. The team will review this interview before any decision. Thank them, say the team will review the interview and get back to them, and ask if they have any questions. Do not say or hint why.",
      `score ${score}${needsReview ? ", requirements need review" : `, under ${FIT_THRESHOLD}`}: the team decides`,
    ];
  }
  const start = work.facts.start_date as string;
  const first = work.facts.first_name ?? "";
  return [
    `OFFER. Say to the candidate: "Good news${first ? `, ${first}` : ""}. ${work.ctx.employerName} would like to offer you the ${base.jobTitle} job at ${site?.label ?? "the site you chose"}, starting ${longDay(start)}. Do you accept?" Then wait for their answer. If they accept, call start_paperwork.`,
    `score ${score}, at least ${FIT_THRESHOLD}: offer made`,
  ];
}

/** start_paperwork: the candidate accepted. Create the hire; its hosted link opens on their screen. */
async function paperworkFor(
  database: D1Database,
  row: Row,
  config: OnboardedConfig,
  behind: ApiCall[],
): Promise<[answer: string, outcome: string]> {
  const work = parse<Work>(row.work, {} as Work);
  const describe = (hire: HireRecord): string => {
    const mine = (hire.tasks ?? []).filter((t) => t.mine).map((t) => t.name);
    const first = taskInHand(hire, work.ctx, null)?.name;
    return `READY. Their hire is in Onboarded and ${mine.length} form${mine.length === 1 ? " is" : "s are"} open on their screen now, under this call. They come one after another in this order: ${mine.join(", ")}.${first ? ` The one on their screen first is ${first}.` : ""} Which form is on their screen changes as they go: call read_form to know, never go by this list. Their name is already filled in from what they told you. Tell them that in two or three short sentences, say you are staying on the line and they can ask you about any form, then stop talking and wait.`;
  };
  const existing = parse<HireRecord | null>(row.hire, null);
  if (existing) return [describe(existing), "already hired"];
  if (work.offer?.state === "accepting") {
    return ["WAIT. The hire is already being created. Say nothing more about it; the forms will open on their screen in a few seconds.", "already under way"];
  }
  if (work.offer?.state !== "offered") {
    return ["MISSING. No offer has been made on this call yet. Call request_offer first.", "no offer yet"];
  }
  // Claim the hire: a second start_paperwork (a repeated tool call, or an MCP client) must not make a second placement.
  const claimed = await database
    .prepare(
      `UPDATE interview_sessions SET work = json_set(work, '$.offer.state', 'accepting')
       WHERE id = ? AND hire IS NULL AND status NOT IN ('approving', 'approved') AND json_extract(work, '$.offer.state') = 'offered'`,
    )
    .bind(row.id)
    .run();
  if (!claimed.meta.changes) {
    const now2 = parse<HireRecord | null>(((await readRow(database, row.id)) as Row).hire, null);
    return now2 ? [describe(now2), "already hired"] : ["WAIT. The hire is already being created. The forms will open on their screen in a few seconds.", "already under way"];
  }
  const counter = newCounter();
  try {
    // The call goes on, so the interview stays live; it becomes approved when the call ends.
    const hire = await hireFor(database, row, config, counter, null);
    await database
      .prepare("UPDATE interview_sessions SET work = json_set(work, '$.offer.state', 'accepted') WHERE id = ?")
      .bind(row.id)
      .run();
    behind.push(...counter.calls);
    return [describe(hire), `${(hire.tasks ?? []).length} tasks created, link opened on the candidate's screen`];
  } catch (e) {
    behind.push(...counter.calls);
    // The hire did not happen: the offer stands, and start_paperwork can be tried again.
    await database
      .prepare("UPDATE interview_sessions SET work = json_set(work, '$.offer.state', 'offered') WHERE id = ? AND hire IS NULL")
      .bind(row.id)
      .run();
    throw e;
  }
}

/** read_form: what the form in hand says and what the candidate has entered, from Onboarded. */
async function formFor(
  database: D1Database,
  row: Row,
  config: OnboardedConfig,
  named: string | null,
  behind: ApiCall[],
): Promise<[answer: string, outcome: string]> {
  const work = parse<Work>(row.work, {} as Work);
  let hire = parse<HireRecord | null>(row.hire, null);
  if (!hire) {
    return ["MISSING. No forms are open yet: they open after the candidate accepts an offer. For questions about what a site requires, use get_requirements.", "no forms open yet"];
  }
  const counter = newCounter();
  try {
    // Which form is in hand is read fresh: the candidate moves through Onboarded's page on their own.
    const formOrder = [...new Set((work.check?.steps ?? []).map((s) => s.formId))];
    const fresh = await refreshHire(config, work.ctx, hire, formOrder, true, null);
    if (fresh !== hire) {
      hire = fresh;
      await database.prepare("UPDATE interview_sessions SET hire = ? WHERE id = ?").bind(JSON.stringify(hire), row.id).run();
    }
    const task = taskInHand(hire, work.ctx, named);
    if (!task) return ["MISSING. None of the forms on this hire are the candidate's to fill in.", "no form found"];
    // Ava is told where the candidate is, so "which form is this?" has an answer of its own.
    const hand = taskInHand(hire, work.ctx, null);
    const mine = (hire.tasks ?? []).filter((t) => t.mine);
    const list = mine.map((t, i) => `${i + 1}. ${t.name}${t.mineDone ? " (done)" : t.id === hand?.id ? " (on their screen now)" : ""}`).join(", ");
    const where = [
      hand === null || hand.mineDone
        ? "The candidate has finished all of their forms."
        : task.id === hand.id
          ? `This is the form on the candidate's screen now, form ${mine.indexOf(hand) + 1} of ${mine.length}.`
          : `This is the form they named. The form on their screen now is ${hand.name}, form ${mine.indexOf(hand) + 1} of ${mine.length}.`,
      `Their forms, in the order they come: ${list}.`,
    ].join(" ");
    const answer = await readFormForAva(config, counter, work.ctx, task, where);
    behind.push(...counter.calls);
    return [answer, task.id === hand?.id ? `read ${task.name}, the form on screen` : `read ${task.name}`];
  } catch (e) {
    behind.push(...counter.calls);
    throw e;
  }
}

// -- The candidate's own page (/i/<token>) --------------------------------------------------
// No app login: the link's token is the credential. These routes give out nothing of the
// recruiter's side, and accept only what a call produces (its transcript, its start and end).

const candidateViewOf = async (c: Context, row: Row): Promise<CandidateInterview> => {
  const view = viewOf(row);
  const hire = parse<HireRecord | null>(row.hire, null);
  const work = parse<Work>(row.work, {} as Work);
  let formApp: CandidateFormApp | null = null;
  if (hire?.onboardingUrl && /^https?:\/\//i.test(hire.onboardingUrl)) {
    const mine = (hire.tasks ?? []).filter((t) => t.mine);
    const done = mine.filter((t) => t.mineDone).length;
    formApp = {
      url: hire.onboardingUrl,
      done,
      total: mine.length,
      allSet: mine.length > 0 && done === mine.length,
      startDay: hire.startDate ? shortDay(hire.startDate) : null,
      site: work.ctx.sites.find((s) => s.id === work.facts.work_location)?.label ?? null,
    };
  }
  const stage: JourneyStage = view.journey.stage;
  return {
    stage,
    formApp,
    state:
      row.status === "idle" ? "ready" : row.status === "live" ? "live" : row.status === "approved" ? "offer" : "done",
    candidateFirst: view.candidate.first,
    employer: view.job.employer,
    jobTitle: view.job.title,
    voiceReady: !!c.env.VAPI_PRIVATE_KEY?.trim(),
    agentName: view.agentName,
    agentFace: view.agentFace,
    brand: view.brand,
    questionCount: 2,
    questionNow: row.status === "idle" ? 0 : Math.min(2, view.criteria.filter((q) => q.score !== null).length + (stage === "screen" && row.status === "live" ? 1 : 0)),
    onboardingUrl: row.status === "approved" ? (hire?.onboardingUrl ?? null) : null,
  };
};

/** A link works only while its account has AI interviews turned on. */
const linkedRow = async (c: Context): Promise<Row | null> => {
  const row = await readByToken(db(c), c.req.param("token") ?? "");
  return row;
};

export async function getCandidateInterview(c: Context) {
  const row = await linkedRow(c);
  if (!row) return c.json({ error: "This interview link is not valid." }, 404);
  // The candidate's page stays open through the forms: its reads follow the hire.
  return c.json(await candidateViewOf(c, await followHire(c, row)));
}

export async function startCandidateCall(c: Context) {
  const database = db(c);
  const row = await linkedRow(c);
  if (!row) return c.json({ error: "This interview link is not valid." }, 404);
  if (row.status === "live") return c.json({ error: "This interview is already in progress on another device." }, 409);
  if (row.status !== "idle") return c.json({ error: "This interview is already complete." }, 409);
  // One call per session. The start is claimed before Vapi is asked for a call, so a second
  // request, or a loop of them, cannot create more calls (each could run for an hour). A claim
  // that never became a call can be taken again after 90 seconds.
  const claimed = await database
    .prepare("UPDATE interview_sessions SET call = json_set(call, '$.claimedAt', ?) WHERE id = ? AND status = 'idle' AND (json_extract(call, '$.claimedAt') IS NULL OR json_extract(call, '$.claimedAt') < ?)")
    .bind(now(), row.id, new Date(Date.now() - 90_000).toISOString())
    .run();
  if (!claimed.meta.changes) return c.json({ error: "This interview is already starting. Give it a moment." }, 409);
  const release = () => database.prepare("UPDATE interview_sessions SET call = json_remove(call, '$.claimedAt') WHERE id = ? AND status = 'idle'").bind(row.id).run();
  try {
    const response = await callFor(c, (await readRow(database, row.id)) as Row);
    if (response.status >= 400) await release();
    return response;
  } catch (e) {
    await release();
    throw e;
  }
}

export async function postCandidateEvents(c: Context) {
  const database = db(c);
  const row = await linkedRow(c);
  if (!row) return c.json({ error: "This interview link is not valid." }, 404);
  if (row.status !== "idle" && row.status !== "live") return c.json({ error: "This interview is already complete." }, 409);
  const body = await c.req.json<InterviewEvents>().catch(() => ({}) as InterviewEvents);
  // Only the call itself: answers and scores come from Ava's tools, never from this page.
  await recordCall(database, row, {
    ...(Array.isArray(body?.lines) ? { lines: body.lines.slice(0, 20) } : {}),
    ...(body?.call === "start" || body?.call === "end" ? { call: body.call } : {}),
    ...(typeof body?.callSeconds === "number" && Number.isFinite(body.callSeconds) ? { callSeconds: body.callSeconds } : {}),
  });
  return c.json(await candidateViewOf(c, (await readRow(database, row.id)) as Row));
}

// -- The Onboarded MCP server (see services/onboardedMcp.ts) -------------------------------------
// MCP over HTTP, one JSON-RPC message per POST, no session state: each call is answered from
// the interview session. Two doors onto the same server:
//   the agent's (every tool, opened by the session's secret), and
//   the candidate's page (show_forms only, opened by the link's token), which hosts the form app.

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** What show_forms and start_paperwork hand to the form app. */
function formAppContent(row: Row): FormAppContent {
  const view = viewOf(row);
  const hire = parse<HireRecord | null>(row.hire, null);
  const work = parse<Work>(row.work, {} as Work);
  const mine = (hire?.tasks ?? []).filter((t) => t.mine);
  const done = mine.filter((t) => t.mineDone).length;
  return {
    // Only a web address is ever handed to the form app to frame.
    url: hire?.onboardingUrl && /^https?:\/\//i.test(hire.onboardingUrl) ? hire.onboardingUrl : null,
    done,
    total: mine.length,
    allSet: mine.length > 0 && done === mine.length,
    candidateFirst: view.candidate.first,
    employer: view.job.employer,
    startDay: hire?.startDate ? shortDay(hire.startDate) : null,
    site: work.ctx.sites.find((s) => s.id === work.facts.work_location)?.label ?? null,
  };
}

const originOf = (url: string | null): string | null => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

async function answerMcp(c: Context, row: Row, scope: "agent" | "candidate", message: JsonRpc): Promise<unknown> {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "onboarded-forms", title: "Onboarded forms", version: "1.0.0" },
        instructions:
          "Onboarded's onboarding forms for one hire, through Onboarded's public API. show_forms and start_paperwork carry the form app (a ui:// resource): the host shows it, and it shows Onboarded's hosted onboarding page.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: mcpTools(scope) };
    case "resources/list":
      return { resources: [formAppResource()] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      if (params.uri !== FORM_APP_URI) throw new McpError(-32002, `No such resource: ${String(params.uri)}`);
      const hire = parse<HireRecord | null>(row.hire, null);
      return { contents: [{ uri: FORM_APP_URI, mimeType: FORM_APP_MIME, text: formAppHtml(), _meta: formAppMeta(originOf(hire?.onboardingUrl ?? null)) }] };
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!mcpTools(scope).some((t) => t.name === name)) throw new McpError(-32602, `Unknown tool: ${name}`);
      const args = params.arguments !== null && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      if (name === "show_forms") {
        const content = formAppContent((await followHire(c, row)) ?? row);
        return {
          content: [
            {
              type: "text",
              text: content.url
                ? `${content.done} of ${content.total} of the candidate's forms are done. The hosted onboarding page is open in the form app.`
                : "No forms are open yet: they open once the candidate accepts an offer.",
            },
          ],
          structuredContent: content,
          isError: false,
        };
      }
      const text = await runTool(c, row.id, await getConfig(c.env), parse<Base>(row.base, {} as Base), name, args, undefined);
      const after = (await readRow(db(c), row.id)) ?? row;
      return {
        content: [{ type: "text", text }],
        ...(name === "start_paperwork" ? { structuredContent: formAppContent(after) } : {}),
        isError: /^PROBLEM\b/.test(text),
      };
    }
    default:
      throw new McpError(-32601, `Method not found: ${String(message.method)}`);
  }
}

class McpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

async function serveMcp(c: Context, row: Row, scope: "agent" | "candidate") {
  const message = await c.req.json<JsonRpc>().catch(() => null);
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC 2.0 request per POST." } }, 400);
  }
  // A notification (no id) is accepted and gets no body.
  if (message.id === undefined || message.id === null) return c.body(null, 202);
  try {
    return c.json({ jsonrpc: "2.0", id: message.id, result: await answerMcp(c, row, scope, message) });
  } catch (e) {
    const code = e instanceof McpError ? e.code : -32603;
    return c.json({ jsonrpc: "2.0", id: message.id, error: { code, message: messageOf(e).slice(0, 300) } });
  }
}

/** The agent's door: any MCP client that holds the session's secret (as a Bearer token or the tool header). */
export async function sessionMcp(c: Context) {
  const row = await readRow(db(c), c.req.param("id") ?? "");
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!row || (!(await secretMatches(c.req.header("x-bca-tool-secret"), row.tool_secret)) && !(await secretMatches(bearer, row.tool_secret)))) {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown session" } }, 401);
  }
  return serveMcp(c, row, "agent");
}

/** The candidate's door: their page hosts the form app, and may call show_forms and nothing else. */
export async function candidateMcp(c: Context) {
  const row = await linkedRow(c);
  if (!row) {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This interview link is not valid." } }, 404);
  }
  return serveMcp(c, row, "candidate");
}
