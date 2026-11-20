import type { Brand } from "./builder";
// Contract for the call session, shared by the server
// (src/server/services/interview.ts, src/server/endpoints/sessions.ts) and the UI
// (src/app/components/call/). The interviewer's own data (transcript, scores)
// is this app's. Everything in `RequirementsCheck` and
// `HireStatus` is computed from Onboarded's public API.

export type Speaker = "ai" | "candidate";

export interface TranscriptLine {
  /** Stable id: the script line index in replay, the Vapi message time in a live call. */
  id: string;
  /** Seconds into the call. */
  at: number;
  who: Speaker;
  text: string;
}

/** The facts the interviewer can send. Keys match `RequirementQuestion.key`. */
export type FactKey = "first_name" | "last_name" | "email" | "work_location" | "start_date";

export type Facts = Partial<Record<FactKey, string>>;

export interface QuestionOption {
  /** Onboarded id (a client id for a work site). */
  value: string;
  label: string;
  /** "Chicago, IL" */
  detail: string | null;
}

/** One answer the employer's Onboarded account needs. */
export interface RequirementQuestion {
  key: FactKey;
  label: string;
  kind: "date" | "option" | "text";
  /** Decides a step or a deadline. Optional ones only prefill forms. */
  required: boolean;
  options?: QuestionOption[];
  /** Where it lives in Onboarded, e.g. "placement.custom_attributes.start_date". */
  source: string;
}

export type StepChange = "added" | "removed" | "same";
export type DeadlineTone = "ok" | "warn" | "bad" | "unknown";
export type Side = "employee" | "employer" | "system";

/** A form step a fact decided, shown under that fact's row. */
export interface CheckStep {
  formId: string;
  /** Short form name, e.g. "DR 0004". */
  label: string;
  /** "work location's state is CO" */
  why: string | null;
  change: StepChange;
}

export interface CheckDeadline {
  id: string;
  /** "I-9 Section 1 by Mon, Nov 9" */
  text: string;
  /** "due today" | "on time" | "overdue" */
  word: string | null;
  tone: DeadlineTone;
  /** "8 CFR 274a.2(b)(1)(i)(A)" */
  citation: string | null;
  /** What is due, for the interviewer to say: "I-9 Section 1". */
  what: string;
  /** YYYY-MM-DD */
  due: string | null;
}

export interface CheckRow {
  key: FactKey;
  label: string;
  /** The answer as shown: "Denver fulfillment center", "Mon, Nov 16". */
  answer: string | null;
  covered: boolean;
  steps: CheckStep[];
  deadlines: CheckDeadline[];
}

/** One step of the onboarding the hire would get: a form section and who completes it. */
export interface PlanStep {
  id: string;
  formId: string;
  /** "I-9 · Section 1" */
  title: string;
  side: Side;
  /** Row key of the fact that decided this step, or null when every hire gets it. */
  decidedBy: FactKey | null;
}

export interface RequirementsCheck {
  /** Compact card's top line. */
  summary: string;
  rows: CheckRow[];
  /** "Not asked before the offer: Date of birth, Social Security number. Dana enters them on the forms." */
  notAsked: string | null;
  /** Row whose answer changed last, kept in view. */
  latest: FactKey | null;
  steps: PlanStep[];
  counts: { steps: number; employee: number };
  /** Start date as YYYY-MM-DD, when known. */
  startDate: string | null;
  /** Review card paragraph. */
  why: string;
  stillOpen: string[];
  /** For the interviewer to say: "your I-9 Section 1 would be due today". Null when nothing is at risk. */
  risk: string | null;
  /** How many Onboarded API calls produced this check (shown in the dev log). */
  apiCalls: number;
}

export type RowState = "not_started" | "open" | "done";

export interface HireRow {
  id: string;
  title: string;
  side: Side;
  state: RowState;
  /** "To do · Employee", "In review · Employer", "Employee" */
  note: string;
}

export interface HireEvent {
  /** ISO time */
  at: string;
  /** "placement.created · 4 tasks" */
  text: string;
}

export interface HireStatus {
  placementId: string;
  employeeId: string;
  rows: HireRow[];
  done: number;
  total: number;
  ready: boolean;
  startedAt: string;
  readyAt: string | null;
  /** YYYY-MM-DD */
  startDate: string | null;
  events: HireEvent[];
  /** The candidate's hosted onboarding link. */
  onboardingUrl: string | null;
  /** The employer's link for their part (I-9 Section 2), when one is open. */
  employerUrl: string | null;
}

export interface Criterion {
  id: string;
  label: string;
  score: number | null;
}

export interface PhoneText {
  id: string;
  text: string;
  /** A link inside the text, opened in the phone's browser. */
  link: string | null;
}

/** One call between this app and a service, shown in the API feed. */
export interface ApiCall {
  id: string;
  /** ISO time */
  at: string;
  /** "payroll" is an employer payroll system outside Onboarded (kept from an earlier Onboarded demo; unused here). */
  service: "onboarded" | "vapi" | "payroll";
  /** "in" is a call the service made to this app (Vapi's tool webhook). */
  direction: "out" | "in";
  method: "GET" | "POST" | "PATCH";
  /** Path with long ids shortened: "/tasks/task_XXXX…". */
  path: string;
  /** What the call is for, in plain words. */
  detail: string | null;
  /** The request, as "key: value" lines (ids shortened). */
  sent: string[];
  status: number;
  /** A preview of the response, as "key: value" lines. */
  returned: string[];
  /** The outcome in a few words: "3 forms: I-9, W-4, IL-W-4". */
  result: string | null;
  ms: number;
}

export type InterviewMode = "live" | "replay";

/**
 * Which interviewer runs the call. 1 is the interview alone: the call ends and the recruiter
 * approves afterwards. 2 ("AI Interview Agent 2") stays on the call from the screening to the
 * last form: it makes the offer by the account's rule, opens Onboarded's hosted onboarding
 * page inside the call, and hands the withholding to payroll.
 */
export type AgentVersion = 1 | 2;

export type JourneyStage = "screen" | "offer" | "forms" | "ready";

export interface JourneyStep {
  id: JourneyStage;
  /** "1. Screen" */
  label: string;
  state: "done" | "now" | "todo";
  /** "Done, 6 minutes" · "Dana has done 1 of her 5. Placement: 0 of 6 complete." */
  detail: string;
}

/** Where a form on the placement comes from, when the account says so with a form tag. */
export type FormSource = "library" | "custom" | "integration";

/** One form the placement requires, for the watch view's requirements table. */
export interface AgentForm {
  taskId: string;
  formId: string;
  /** The account's short name: "W-4". */
  name: string;
  /** One line under the name: what the form is, or why it applies. */
  note: string | null;
  source: FormSource | null;
  /** "Dana" · "ACME" · "Dana, then ACME" */
  whose: string;
  /** "Not started" · "In progress, 25%" · "Dana's part done" · "Complete" */
  status: string;
  state: "todo" | "open" | "part" | "done";
  /** 0 to 100, the task's own progress as Onboarded reports it. */
  percent: number;
  /** "Nov 30" or "Dana: Nov 30 · ACME: Dec 3"; null when the form carries no deadline rule. */
  due: string | null;
  /** The form on the candidate's screen now, as far as Onboarded's task reads can tell. */
  now?: boolean;
}

export interface Journey {
  stage: JourneyStage;
  steps: JourneyStep[];
  /** "none" before the screening is done; "review" when the score is under the account's threshold. */
  offer: "none" | "offered" | "accepted" | "review";
  forms: AgentForm[];
  /** The candidate's own forms: done of total. */
  mine: { done: number; total: number };
}
export type InterviewStatus = "idle" | "live" | "ended" | "review" | "approving" | "approved" | "rejected";

export interface InterviewSession {
  id: string;
  /** The path from the screening to ready for work. */
  journey: Journey;
  status: InterviewStatus;
  /** Placeholders until the call gives a name. */
  candidate: { first: string; last: string; email: string; initials: string };
  /** `employer` is the visitor's company; `threshold` is the fit score an offer needs. */
  job: { title: string; employer: string; threshold: number };
  /** YYYY-MM-DD, the day of the call as the browser sees it. */
  today: string;
  /** YYYY-MM-DD, the start date the interviewer offers. */
  offeredStart: string;
  questions: RequirementQuestion[];
  facts: Facts;
  transcript: TranscriptLine[];
  criteria: Criterion[];
  score: number;
  check: RequirementsCheck | null;
  hire: HireStatus | null;
  /** Seconds the call lasted or has lasted. */
  callSeconds: number;
  /** Last Onboarded error, shown in the studio header. */
  error: string | null;
  /** The calls behind the card, oldest first. */
  api: ApiCall[];
  /** The candidate's own link to this interview (/i/<token>), when it has one. */
  linkToken: string | null;
  /** The visitor's agent: its name, face (1 to 10), company and brand. */
  agentName: string;
  agentFace: number;
  company: string;
  brand: Brand;
}

/** An application's interview link, for its card on the pipeline. */
export interface InterviewLink {
  applicationId: string;
  sessionId: string;
  token: string;
  status: InterviewStatus;
  score: number;
  updatedAt: string;
}

export interface InterviewLinks {
  /** AI interviews are turned on for this account. When off there are no links. */
  enabled: boolean;
  /** In local development, the tunnel's address: a link built on it opens on any device. */
  publicBase: string | null;
  links: InterviewLink[];
}

/**
 * What the candidate's own page (/i/<token>) is told. Nothing of the recruiter's
 * side: no scores, no requirements, no API log.
 */
export interface CandidateInterview {
  /** "ready" to start, "live" on a call, "done" after it, "offer" once the recruiter approves. */
  state: "ready" | "live" | "done" | "offer";
  /** How far along the candidate is, for the bar at the top of their screen. */
  stage: JourneyStage;
  /**
   * Agent 2 only, once the offer is accepted: Onboarded's form app for this call. `url` is the
   * hosted onboarding link the agent created; the page is shown as it is, in an iframe.
   */
  formApp: CandidateFormApp | null;
  candidateFirst: string;
  employer: string;
  jobTitle: string;
  /** A voice key is set up, so the call can start. */
  voiceReady: boolean;
  /** After the offer: the candidate's hosted onboarding link. */
  onboardingUrl: string | null;
  /** The visitor's agent: its name, face (1 to 10) and brand. `employer` is the visitor's company. */
  agentName: string;
  agentFace: number;
  brand: Brand;
  /** How many screening questions the agent asks, and which one it is on (0 before the first). */
  questionCount: number;
  questionNow: number;
}

export interface CandidateFormApp {
  /** Onboarded's hosted onboarding link for this hire. */
  url: string;
  /** The candidate's own forms: done of total. */
  done: number;
  total: number;
  /** Every form that is the candidate's to do is done. */
  allSet: boolean;
  /** "Mon, Nov 30", the first day agreed on the call. */
  startDay: string | null;
  /** "Los Angeles distribution center" */
  site: string | null;
}

/** Body of POST /api/v1/interviews/:id/events. */
export interface InterviewEvents {
  lines?: TranscriptLine[];
  facts?: Facts;
  scores?: Record<string, number>;
  call?: "start" | "end";
  callSeconds?: number;
}

export interface VoiceSettings {
  /** AI interviews are turned on for this account (Settings). Off hides every interview part. */
  enabled: boolean;
  /** A Vapi private key is stored. */
  configured: boolean;
  keyHint: string | null;
  orgId: string | null;
  /** Public base URL Vapi calls back for tool calls (a tunnel in local dev). */
  toolBaseUrl: string | null;
  /** Which interviewer new interview links get: 1 (the interview alone) or 2 (screen to payroll). */
  agent?: AgentVersion;
  /** This account may have AI interviews at all (set at deploy time, not in the app). */
  allowed?: boolean;
  /** The names of the accounts that may, for the note on a locked switch. Empty when every account may. */
  allowedAccounts?: string[];
}

/** One line of the Settings checklist: something AI interviews need, and whether it is there. */
export interface ReadinessItem {
  id: string;
  label: string;
  ok: boolean;
  /** What was found, or what to do. */
  detail: string;
  /** Not needed for a live interview from a candidate link. */
  optional?: boolean;
}

export interface InterviewReadiness {
  /** Every required item is there. */
  ready: boolean;
  items: ReadinessItem[];
}

/** What the browser needs to join a call the server created. */
export interface VoiceJoin {
  callId: string;
  webCallUrl: string;
  callToken?: string;
  /** Server only: Vapi's control URL for the call. Never sent to the browser. */
  controlUrl?: string;
}

export const FIT_THRESHOLD = 80;

// -- Dates (pure, UTC day arithmetic on YYYY-MM-DD strings) ---------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const parseDay = (iso: string): Date => {
  const [y = 0, m = 1, d = 1] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The local calendar day as YYYY-MM-DD. */
export const localToday = (now = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export const addDays = (iso: string, days: number): string => {
  const d = parseDay(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

/** Adds business days (Monday to Friday; holidays are not modelled). */
export const addBusinessDays = (iso: string, days: number): string => {
  const d = parseDay(iso);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return isoDay(d);
};

/** The first Monday at least a week after `today`. */
export const offeredStartFrom = (today: string): string => {
  const d = parseDay(today);
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return isoDay(d);
};

/** "Monday, November 16" */
export const longDay = (iso: string): string => {
  const d = parseDay(iso);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/** "Mon, Nov 16" */
export const shortDay = (iso: string): string => {
  const d = parseDay(iso);
  return `${WEEKDAYS[d.getUTCDay()]?.slice(0, 3)}, ${MONTHS[d.getUTCMonth()]?.slice(0, 3)} ${d.getUTCDate()}`;
};

export const weekdayOf = (iso: string): string => WEEKDAYS[parseDay(iso).getUTCDay()] ?? "";

/** `m:ss` */
export const formatClock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Time on a test call, not counting the time it was paused. At this the page ends the call. */
export const MAX_CALL_SECONDS = 20 * 60;
/**
 * The longest a call can stay connected, paused time included: Vapi ends it here whatever the
 * page does. A paused call is still connected and Vapi bills its minutes, so pausing can
 * stretch a call by ten minutes at most.
 */
export const MAX_CONNECTED_SECONDS = 30 * 60;
/** Seconds on the call so far, leaving out the time it was paused (all times in milliseconds). */
export const activeSeconds = (now: number, startedAt: number, pausedMs: number, pausedSince: number | null): number =>
  Math.max(0, Math.floor((now - startedAt - pausedMs - (pausedSince === null ? 0 : now - pausedSince)) / 1000));
/** How close to the limit the clock starts counting down. */
const LAST_SECONDS = 120;
/** The call's clock: time on the call, then the time left once two minutes remain. */
export const callClock = (seconds: number): string => {
  const left = Math.max(0, MAX_CALL_SECONDS - seconds);
  return left <= LAST_SECONDS ? `${formatClock(left)} left` : formatClock(seconds);
};
/** Whether a call that ended after being connected this long was cut by Vapi's own limit (it cuts within a second or two of it). */
export const endedAtLimit = (connectedSeconds: number): boolean => connectedSeconds >= MAX_CONNECTED_SECONDS - 5;

/** The live score: criteria scored so far over all of them, so it climbs as they tick. */
export const scoreOf = (criteria: ReadonlyArray<Criterion>): number =>
  criteria.length === 0
    ? 0
    : Math.round(criteria.reduce((sum, c) => sum + (c.score ?? 0), 0) / criteria.length);
