// The Onboarded side of the AI interview screen, over Onboarded's public API:
//
//   questions   GET  /custom_properties, GET /clients      what the employer's account needs answered
//   check       POST /placements/preview                    a dry run of the account's policies (saves nothing)
//   why         the same preview without one fact            forms that drop out were decided by that fact
//   steps       GET  /forms/{id}                             form sections and who completes them
//   deadlines   form custom attributes                       the account stores its deadline rules on its forms
//   hire        POST /placements (create_tasks), PATCH /tasks/{id}
//   status      GET  /tasks/{id}
//
// This app keeps no requirement logic of its own: which forms apply comes from
// the account's policies, and the deadline rules come from attributes the
// account stores on its forms. This code only does the date arithmetic.

import {
  addBusinessDays,
  addDays,
  shortDay,
  type AgentForm,
  type ApiCall,
  type CheckDeadline,
  type CheckRow,
  type CheckStep,
  type FactKey,
  type Facts,
  type FormSource,
  type HireEvent,
  type HireRow,
  type HireStatus,
  type PlanStep,
  type QuestionOption,
  type RequirementQuestion,
  type RequirementsCheck,
  type Side,
} from "../../shared/interview";
import { onboardedFetch } from "./onboarded";
import { redact, redactData } from "./security";

export interface OnboardedConfig {
  apiKey: string;
  apiUrl: string;
}

/** Collects the Onboarded calls a request made, for the count and the studio's API rail. */
export interface CallCounter {
  n: number;
  calls: ApiCall[];
}

export const newCounter = (): CallCounter => ({ n: 0, calls: [] });

/** What a call was for and what to show of its answer, for the API rail. */
interface CallNote {
  detail?: string | null;
  /** The outcome in a few words. */
  result?: (body: unknown) => string | null;
  /** Lines to show of the request; the body's first fields when omitted. */
  sent?: string[];
  /** Lines to show of the response; the first few fields when omitted. */
  returned?: (body: unknown) => string[];
}

/** "/tasks/task_XXXXXXXXXXXXXX" → "/tasks/task_XXXXXXXX…" */
const shortPath = (path: string): string =>
  path.replace(/\b((?:er|ee|cl|job|task|subtask|form|formpage|pla|auto|on)_[A-Za-z0-9]{8})[A-Za-z0-9]{4,}/g, "$1…");

const shortValue = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") {
    const t = shortPath(v);
    return t.length > 58 ? `${t.slice(0, 57)}…` : t;
  }
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  return String(v);
};

/** An object as "key: value" lines, one level of nesting flattened. */
const linesOf = (body: unknown, max = 5): string[] => {
  if (body === null || typeof body !== "object") return [];
  if (Array.isArray(body)) return [`[${body.length} items]`];
  const out: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
        out.push(`${key}.${k2}: ${shortValue(v2)}`);
      }
    } else out.push(`${key}: ${shortValue(value)}`);
  }
  return out.slice(0, max);
};

/** A GET's query string as lines. */
const queryLines = (path: string): string[] => {
  const q = path.split("?")[1];
  return q ? q.split("&").map((pair) => decodeURIComponent(pair).replace("=", ": ")) : [];
};

class OnboardedApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function ob<T>(
  config: OnboardedConfig,
  counter: CallCounter,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  note: CallNote = {},
): Promise<T> {
  counter.n += 1;
  const started = Date.now();
  // Logged when the call starts, so calls made together read in the order they were made.
  const entry: ApiCall = {
    id: `${started}-${counter.n}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date(started).toISOString(),
    service: "onboarded",
    direction: "out",
    method,
    path: shortPath(path),
    detail: note.detail ?? null,
    sent: note.sent ?? (body === undefined ? queryLines(path) : linesOf(body, 5)),
    status: 0,
    returned: [],
    result: null,
    ms: 0,
  };
  counter.calls.push(entry);
  const log = (status: number, result: string | null, returned: string[] = []) => {
    entry.status = status;
    entry.result = result === null ? null : redact(result, [config.apiKey]);
    entry.returned = redactData(returned, [config.apiKey]);
    entry.ms = Date.now() - started;
  };
  let resp: Response;
  try {
    resp = await onboardedFetch(config, path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    log(0, "unreachable");
    throw e;
  }
  const text = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!resp.ok) {
    const message =
      redact(String((parsed as { message?: string } | null)?.message || text.slice(0, 200) || `HTTP ${resp.status}`), [config.apiKey]);
    log(resp.status, message.slice(0, 80), [`message: ${message.slice(0, 120)}`]);
    throw new OnboardedApiError(resp.status, `${method} ${path}: ${resp.status} ${message}`);
  }
  let result: string | null = null;
  let returned: string[] = [];
  try {
    result = note.result ? note.result(parsed) : null;
    returned = (note.returned ? note.returned(parsed) : linesOf(parsed, 5)).slice(0, 9);
  } catch {
    returned = [];
  }
  log(resp.status, result, returned);
  return parsed as T;
}

// -- Shapes read from Onboarded ---------------------------------------------------------

interface ObCustomProperty {
  path: string;
  label: string;
  scalar_type: string;
}

interface ObClient {
  id: string;
  name: string;
  custom_attributes?: Record<string, unknown>;
}

interface ObFormRef {
  id: string;
  name: string;
  custom_attributes?: Record<string, unknown>;
  tags?: unknown;
}

interface ObPlacement {
  id: string;
  job_id?: string | null;
  client_id?: string | null;
  form_requirements?: Array<{ task_id: string | null; form: ObFormRef }>;
}

interface ObFormField {
  type?: string;
  path?: string | null;
  required?: boolean;
  translations?: Record<string, Record<string, string>>;
}

interface ObFormPage {
  description?: string | null;
  assignee_type: string;
  form_section: { position: number; assignee_type: string } | null;
  form_fields?: ObFormField[];
}

interface ObForm extends ObFormRef {
  form_pages?: ObFormPage[];
}

interface ObSubtask {
  assignee_type: string;
  form_section: { position: number; assignee_type: string } | null;
  progress?: { percent?: number; numerator?: number; denominator?: number };
}

interface ObTask {
  id: string;
  form_id: string;
  name: string;
  status: string;
  due_at?: string | null;
  updated_at?: string | null;
  progress?: { percent?: number } | null;
  form_custom_attributes?: Record<string, unknown>;
  next_action?: { type?: string } | null;
  subtasks?: ObSubtask[];
}

// -- What the session keeps about the account -------------------------------------------

interface SiteInfo {
  id: string;
  label: string;
  state: string | null;
  city: string | null;
}

interface FormSection {
  position: number;
  side: Side;
}

interface FormInfo {
  id: string;
  name: string;
  /** The account's short name for the form ("I-9"), else the form's name. */
  short: string;
  sections: FormSection[];
  /** Employee facts the form itself asks for (field paths under `employee.`). */
  employeePaths: string[];
  attrs: Record<string, unknown>;
  /** The account's tags on the form ("library", "custom", "integration" say where it comes from). */
  tags?: string[];
}

/** Everything about the account a session needs, read once when the session starts. */
export interface AccountContext {
  employerId: string | null;
  employerName: string;
  jobId: string | null;
  employeeId: string;
  sites: SiteInfo[];
  questions: RequirementQuestion[];
  forms: Record<string, FormInfo>;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const sideOf = (assignee: string): Side =>
  assignee === "employer" ? "employer" : assignee === "employee" ? "employee" : "system";

const sideLabel: Record<Side, string> = { employee: "Employee", employer: "Employer", system: "Vendor" };

/** What the interviewer does not ask before an offer, whatever the forms could use. */
const NOT_BEFORE_OFFER: ReadonlyArray<{ path: string; label: string }> = [
  { path: "employee.date_of_birth", label: "Date of birth" },
  { path: "employee.social_security_number", label: "Social Security number" },
];

// -- Questions ---------------------------------------------------------------------------

/** The answers this employer's Onboarded account needs, read from the account itself. */
export async function loadQuestions(
  config: OnboardedConfig,
  counter: CallCounter,
): Promise<{ questions: RequirementQuestion[]; sites: SiteInfo[] }> {
  const [propsRaw, clientsRaw] = await Promise.all([
    ob<ObCustomProperty[] | { data: ObCustomProperty[] }>(
      config,
      counter,
      "GET",
      "/custom_properties?entity_type=placement",
      undefined,
      {
        detail: "What does a placement in this account need?",
        returned: (b) => {
          const list = (Array.isArray(b) ? b : ((b as { data?: unknown[] })?.data ?? [])) as ObCustomProperty[];
          const custom = list.filter((x) => x.path.includes("custom_attributes"));
          return (custom.length ? custom : list).map((x) => `${x.path} · ${x.scalar_type}`);
        },
        result: (b) => {
          const list = Array.isArray(b) ? b : ((b as { data?: unknown[] })?.data ?? []);
          const custom = (list as ObCustomProperty[]).filter((x) => x.path.includes("custom_attributes"));
          return custom.length ? custom.map((x) => x.path.split(".").pop()).join(", ") : `${list.length} properties`;
        },
      },
    ),
    ob<{ data: ObClient[] }>(config, counter, "GET", "/clients?per_page=100", undefined, {
      detail: "The employer's work sites, with the state each is in",
      returned: (b) =>
        ((b as { data?: ObClient[] })?.data ?? [])
          .filter((x) => x.custom_attributes?.site_state)
          .map((x) => `${x.name} · site_state: ${String(x.custom_attributes?.site_state)}`),
      result: (b) => {
        const sites = ((b as { data?: ObClient[] })?.data ?? []).filter((x) => x.custom_attributes?.site_state);
        return `${sites.length} work sites`;
      },
    }),
  ]);
  const props = Array.isArray(propsRaw) ? propsRaw : (propsRaw.data ?? []);

  const sites: SiteInfo[] = (clientsRaw.data ?? [])
    .map((c) => ({
      id: c.id,
      label: c.name,
      state: text(c.custom_attributes?.site_state),
      city: text(c.custom_attributes?.site_city),
    }))
    .filter((s) => s.state !== null)
    .sort((a, b) => a.label.localeCompare(b.label));

  const questions: RequirementQuestion[] = [];
  const startDate = props.find((p) => p.path === "placement.custom_attributes.start_date");
  if (startDate) {
    questions.push({
      key: "start_date",
      label: startDate.label,
      kind: "date",
      required: true,
      source: startDate.path,
    });
  }
  if (sites.length > 0) {
    questions.push({
      key: "work_location",
      label: "Work location",
      kind: "option",
      required: true,
      options: sites.map(
        (s): QuestionOption => ({
          value: s.id,
          label: s.label,
          detail: [s.city, s.state].filter(Boolean).join(", ") || null,
        }),
      ),
      source: "client (work site), client.custom_attributes.site_state",
    });
  }
  questions.push(
    { key: "first_name", label: "Legal first name", kind: "text", required: false, source: "employee.first_name" },
    { key: "last_name", label: "Legal last name", kind: "text", required: false, source: "employee.last_name" },
  );
  return { questions, sites };
}

// -- Forms ---------------------------------------------------------------------------------

async function loadForm(
  config: OnboardedConfig,
  counter: CallCounter,
  ref: ObFormRef,
): Promise<FormInfo> {
  const form = await ob<ObForm>(config, counter, "GET", `/forms/${ref.id}`, undefined, {
    detail: "Who completes each section, and the form's own deadline rules",
    returned: (b) => {
      const f = b as ObForm;
      const sides = [...new Set((f.form_pages ?? []).map((pg) => pg.form_section?.assignee_type ?? pg.assignee_type))];
      const attrs = f.custom_attributes ?? {};
      return [
        `name: ${f.name}`,
        `sections: ${sides.join(", ")}`,
        "custom_attributes:",
        ...Object.entries(attrs)
          .filter(([, v]) => v !== null && v !== "")
          .map(([k, v]) => `  ${k}: ${shortValue(v)}`),
      ];
    },
    result: (b) => {
      const f = b as ObForm;
      const sides = [...new Set((f.form_pages ?? []).map((pg) => pg.form_section?.assignee_type ?? pg.assignee_type))];
      return `${text(f.custom_attributes?.short_name) ?? f.name}: ${sides.join(" + ")}`;
    },
  });
  const seen = new Map<number, Side>();
  const employeePaths = new Set<string>();
  for (const page of form.form_pages ?? []) {
    const position = page.form_section?.position ?? 1;
    const side = sideOf(page.form_section?.assignee_type ?? page.assignee_type);
    if (!seen.has(position)) seen.set(position, side);
    for (const field of page.form_fields ?? []) {
      if (typeof field.path === "string" && field.path.startsWith("employee.")) {
        employeePaths.add(field.path);
      }
    }
  }
  const sections = [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([position, side]) => ({ position, side }));
  const attrs = { ...(ref.custom_attributes ?? {}), ...(form.custom_attributes ?? {}) };
  const tags = [form.tags, ref.tags].flatMap((t) => (Array.isArray(t) ? t : [])).filter((t): t is string => typeof t === "string");
  return {
    tags: [...new Set(tags)],
    id: form.id,
    name: form.name,
    short: text(attrs.short_name) ?? form.name,
    sections: sections.length > 0 ? sections : [{ position: 1, side: "employee" }],
    employeePaths: [...employeePaths],
    attrs,
  };
}

/** Adds any form the context has not read yet. */
async function ensureForms(
  config: OnboardedConfig,
  counter: CallCounter,
  ctx: AccountContext,
  refs: ObFormRef[],
): Promise<void> {
  const missing = refs.filter((r) => ctx.forms[r.id] === undefined);
  const loaded = await Promise.all(missing.map((r) => loadForm(config, counter, r)));
  for (const f of loaded) ctx.forms[f.id] = f;
  // The preview carries the form's current attributes: keep them fresh.
  for (const r of refs) {
    const known = ctx.forms[r.id];
    if (known && r.custom_attributes) {
      known.attrs = { ...known.attrs, ...r.custom_attributes };
      known.short = text(known.attrs.short_name) ?? known.name;
    }
  }
}

const stepTitle = (form: FormInfo, section: FormSection): string =>
  form.sections.length > 1 ? `${form.short} · Section ${section.position}` : form.short;

const stepWhat = (form: FormInfo, section: FormSection): string =>
  form.sections.length > 1 ? `${form.short} Section ${section.position}` : form.short;

// -- The requirements check ------------------------------------------------------------------

async function preview(
  config: OnboardedConfig,
  counter: CallCounter,
  ctx: AccountContext,
  facts: Facts,
  without?: FactKey,
): Promise<ObFormRef[]> {
  const body: Record<string, unknown> = { employee_id: ctx.employeeId };
  if (ctx.employerId) body.employer_id = ctx.employerId;
  if (ctx.jobId) body.job_id = ctx.jobId;
  if (facts.work_location && without !== "work_location") body.client_id = facts.work_location;
  if (facts.start_date && without !== "start_date") {
    body.custom_attributes = { start_date: facts.start_date };
  }
  // The facts the interview learned first, then the ids every preview carries.
  const site = ctx.sites.find((x) => x.id === body.client_id);
  const sent = [
    ...(body.client_id ? [`client_id: ${shortValue(body.client_id)}${site?.state ? ` (work site in ${site.state})` : ""}`] : []),
    ...(body.custom_attributes ? [`custom_attributes.start_date: ${facts.start_date}`] : []),
    `employee_id: ${shortValue(body.employee_id)}`,
    ...(body.job_id ? [`job_id: ${shortValue(body.job_id)}`] : []),
    ...(body.employer_id ? [`employer_id: ${shortValue(body.employer_id)}`] : []),
  ];
  const placement = await ob<ObPlacement>(config, counter, "POST", "/placements/preview", body, {
    sent,
    detail:
      without !== undefined
        ? "The same dry run without the work site. The form that drops out is the one the site decided."
        : "Dry run of the account's policies for this hire. Nothing is saved.",
    returned: (b) => {
      const p = b as ObPlacement;
      const forms = p.form_requirements ?? [];
      return [
        `id: ${p.id}`,
        `form_requirements: [${forms.length}]`,
        ...forms.map((r) => `  form: ${r.form.name}`),
      ];
    },
    result: (b) => {
      const forms = ((b as ObPlacement)?.form_requirements ?? []).map(
        (r) => text(r.form.custom_attributes?.short_name) ?? r.form.name,
      );
      return `${forms.length} form${forms.length === 1 ? "" : "s"}: ${forms.join(", ")}`;
    },
  });
  return (placement.form_requirements ?? []).map((r) => r.form);
}

function deadlinesFor(form: FormInfo, startDate: string, today: string): CheckDeadline[] {
  const out: CheckDeadline[] = [];
  const add = (side: Side, due: string, citation: string | null) => {
    const section = form.sections.find((s) => s.side === side);
    if (!section) return;
    const what = stepWhat(form, section);
    const tone = due < today ? "bad" : due === today ? "warn" : "ok";
    out.push({
      id: `${form.id}:${side}`,
      what,
      due,
      text: `${what} by ${shortDay(due)}`,
      word: due < today ? "overdue" : due === today ? "due today" : "on time",
      tone,
      citation,
    });
  };
  const employeeDays = num(form.attrs.employee_due_days_from_start);
  if (employeeDays !== null) {
    add("employee", addDays(startDate, employeeDays), text(form.attrs.employee_due_citation));
  }
  const employerDays = num(form.attrs.employer_due_business_days_from_start);
  if (employerDays !== null) {
    add("employer", addBusinessDays(startDate, employerDays), text(form.attrs.employer_due_citation));
  }
  return out;
}

const siteWhy = (site: SiteInfo | undefined): string | null =>
  site?.state ? `work location's state is ${site.state}` : null;

const listWords = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

interface CheckInput {
  facts: Facts;
  today: string;
  candidateFirst: string;
  /** The check before this one, to mark steps added and removed. */
  previous: RequirementsCheck | null;
  /** The fact that changed last. */
  latest: FactKey | null;
}

/** Runs the account's policies for the facts so far and words the result for the card. */
export async function computeCheck(
  config: OnboardedConfig,
  ctx: AccountContext,
  input: CheckInput,
  counter: CallCounter = newCounter(),
): Promise<RequirementsCheck> {
  const { facts, today } = input;

  const [full, withoutSite] = await Promise.all([
    preview(config, counter, ctx, facts),
    facts.work_location ? preview(config, counter, ctx, facts, "work_location") : Promise.resolve(null),
  ]);
  await ensureForms(config, counter, ctx, full);

  const site = ctx.sites.find((s) => s.id === facts.work_location);
  const baseIds = new Set((withoutSite ?? full).map((f) => f.id));
  const decidedBySite = withoutSite === null ? [] : full.filter((f) => !baseIds.has(f.id));
  const decidedIds = new Set(decidedBySite.map((f) => f.id));

  // Steps: one per form section, the forms every hire gets first.
  const forms = full.map((f) => ctx.forms[f.id]).filter((f): f is FormInfo => f !== undefined);
  const ordered = [...forms.filter((f) => !decidedIds.has(f.id)), ...forms.filter((f) => decidedIds.has(f.id))];
  const steps: PlanStep[] = ordered.flatMap((form) =>
    form.sections.map((section) => ({
      id: `${form.id}:${section.position}`,
      formId: form.id,
      title: stepTitle(form, section),
      side: section.side,
      decidedBy: decidedIds.has(form.id) ? ("work_location" as const) : null,
    })),
  );

  // Rows: required questions first, then each optional one once it is answered.
  const previousSiteSteps = (
    input.previous?.rows.find((r) => r.key === "work_location")?.steps ?? []
  ).filter((s) => s.change !== "removed");
  const why = siteWhy(site);
  // A form can say for itself when it applies ("the shift operates a forklift"): the account
  // stores that on the form. A form that does not is explained by the site's state.
  const whyOf = (formId: string): string | null => text(ctx.forms[formId]?.attrs.applies_when) ?? why;
  const siteSteps: CheckStep[] = [
    ...decidedBySite.map((f): CheckStep => {
      const info = ctx.forms[f.id];
      return {
        formId: f.id,
        label: info?.short ?? f.name,
        why: whyOf(f.id),
        change: previousSiteSteps.some((p) => p.formId === f.id) ? "same" : "added",
      };
    }),
    ...previousSiteSteps
      .filter((p) => !decidedIds.has(p.formId))
      .map((p): CheckStep => ({ ...p, change: "removed" })),
  ];

  const deadlines: CheckDeadline[] = facts.start_date
    ? forms
        .flatMap((f) => deadlinesFor(f, facts.start_date as string, today))
        .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))
    : [];

  const answerOf = (q: RequirementQuestion): string | null => {
    const value = facts[q.key];
    if (value === undefined || value === "") return null;
    if (q.kind === "option") return q.options?.find((o) => o.value === value)?.label ?? value;
    if (q.kind === "date") return value === today ? `Today, ${shortDay(value)}` : shortDay(value);
    return value;
  };

  const rows: CheckRow[] = ctx.questions
    .filter((q) => q.required || facts[q.key] !== undefined)
    .map((q) => ({
      key: q.key,
      label: q.label,
      answer: answerOf(q),
      covered: facts[q.key] !== undefined && facts[q.key] !== "",
      steps: q.key === "work_location" ? siteSteps : [],
      deadlines: q.key === "start_date" ? deadlines : [],
    }));

  // Words.
  const employeeSteps = steps.filter((s) => s.side === "employee").length;
  const decidedLabels = decidedBySite.map((f) => ctx.forms[f.id]?.short ?? f.name);
  const reasons = decidedBySite.map((f) => whyOf(f.id));
  const decidedSentence =
    site === undefined
      ? ""
      : decidedLabels.length === 0
        ? ` The work location's state is ${site.state}, which adds no step.`
        : new Set(reasons).size === 1
          ? ` Includes the ${listWords(decidedLabels)} step because the ${reasons[0] ?? "work location is set"}.`
          : ` Includes ${listWords(decidedLabels.map((label, i) => `${label} (${reasons[i] ?? "this work location"})`))}.`;
  const dueSentence = facts.start_date ? ` Due by ${shortDay(facts.start_date)}.` : "";
  const decided = site !== undefined || facts.start_date !== undefined;
  const summary = decided
    ? `${steps.length} step${steps.length === 1 ? "" : "s"} if hired.${decidedSentence}${dueSentence}`
    : "Steps and deadlines show here as the answers come in.";

  const asked = new Set(forms.flatMap((f) => f.employeePaths));
  const notAskedLabels = NOT_BEFORE_OFFER.filter((n) => asked.has(n.path)).map((n) => n.label);
  const notAsked =
    notAskedLabels.length === 0
      ? null
      : `Not asked before the offer: ${notAskedLabels.join(", ")}. ${input.candidateFirst} enters them on the forms.`;

  const whyParagraph =
    `From ${ctx.employerName}'s onboarding policies in Onboarded` +
    (site ? ` for a job at ${site.label}${site.state ? `, ${site.state}` : ""}.` : ".") +
    decidedSentence;

  const stillOpen = ctx.questions
    .filter((q) => q.required && (facts[q.key] === undefined || facts[q.key] === ""))
    .map((q) => `${q.label} is not answered yet.`);

  const atRisk = deadlines.find((d) => d.tone === "warn" || d.tone === "bad");
  const risk = atRisk
    ? `your ${atRisk.what} would be ${atRisk.tone === "bad" ? "overdue already" : "due today"}`
    : null;

  return {
    summary,
    rows,
    notAsked,
    latest: input.latest,
    steps,
    counts: { steps: steps.length, employee: employeeSteps },
    startDate: facts.start_date ?? null,
    why: whyParagraph,
    stillOpen,
    risk,
    apiCalls: counter.n,
  };
}

/**
 * A work site's requirements in words, for Ava to explain on the call. Everything in it comes from
 * the Onboarded account: which forms (its policies), what each one is, when it applies and
 * what to have ready (attributes the account stores on its forms), and the deadlines.
 */
export function requirementsForAva(check: RequirementsCheck, ctx: AccountContext, site: SiteInfo | undefined): string {
  const formIds = [...new Set(check.steps.map((s) => s.formId))];
  const decided = new Map(check.rows.find((r) => r.key === "work_location")?.steps.map((s) => [s.formId, s.why]) ?? []);
  const lines = formIds.map((id, i) => {
    const form = ctx.forms[id];
    if (!form) return `${i + 1}. A form Onboarded could not describe.`;
    const who = form.sections.some((x) => x.side === "employer")
      ? "The candidate fills in their part and the employer completes the rest."
      : "The candidate fills it in.";
    const applies = decided.has(id) ? `Needed because the ${decided.get(id) ?? "work site requires it"}.` : "Needed for every hire.";
    const summary = text(form.attrs.summary);
    const bring = text(form.attrs.bring);
    return `${i + 1}. ${form.short}${form.short === form.name ? "" : ` (${form.name.trim()})`}: ${summary ?? "No description on file."} ${applies} ${who}${bring ? ` Have ready: ${bring}.` : ""}`;
  });
  const where = site
    ? `${site.label}${site.city ? ` (${[site.city, site.state].filter(Boolean).join(", ")})` : ""}.`
    : "No work site chosen.";
  const deadlines = check.rows.flatMap((r) => r.deadlines).map((d) => `${d.text}${d.citation ? ` (${d.citation})` : ""}`);
  return [
    `Work site: ${where}`,
    `Onboarded requires ${formIds.length} form${formIds.length === 1 ? "" : "s"} for a hire at this site:`,
    ...lines,
    deadlines.length ? `Deadlines for the start date on file: ${deadlines.join("; ")}.` : "No deadline rule was returned for the fixed start date.",
    "All of it is done online, on the candidate's screen under this call once they accept the offer.",
    "Explain this in plain words, a few sentences at a time. Say only what is written here.",
  ].join("\n");
}

// -- The hire ----------------------------------------------------------------------------------

export interface HireRecord {
  placementId: string;
  employeeId: string;
  taskIds: string[];
  startedAt: string;
  readyAt: string | null;
  startDate: string | null;
  onboardingUrl: string | null;
  employerUrl: string | null;
  events: HireEvent[];
  rows: HireRow[];
  /** ISO time of the last status read, to throttle polling. */
  polledAt: string | null;
  /** The tasks as last read, one per form (Agent 2's requirements table and form reading). */
  tasks?: TaskSnap[];
  /** Task ids in the order the hosted link shows them, when the link was made with that order (`task_ids`). */
  linkOrder?: string[];
}

/** What the last read of a task said. */
interface TaskSnap {
  id: string;
  formId: string;
  name: string;
  status: string;
  /** 0 to 100: how far the candidate's own part is. */
  percent: number;
  /** The percent at the first read: fields the hire prefilled count as progress before the candidate has typed. */
  from?: number;
  /** Onboarded's next_action.type: "employee_action", "employer_action", ... */
  next: string | null;
  dueAt: string | null;
  /** The candidate's part of this form is done. */
  mineDone: boolean;
  /** The candidate has a part in this form at all. */
  mine: boolean;
  /** Onboarded's updated_at for the task. The hosted page moves it each time a page of the task loads or is saved. */
  updatedAt?: string | null;
  /** updated_at at the first read, before the candidate had done anything this page could see. */
  updated0?: string | null;
}

/** A progress figure as 0 to 100 (Onboarded reports a fraction). */
const percentOf = (v: unknown): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(100, Math.round(n <= 1 ? n * 100 : n)));
};

function snapOf(task: ObTask, form: FormInfo | undefined): TaskSnap {
  const mineSections = (form?.sections ?? [{ position: 1, side: "employee" as Side }]).filter((x) => x.side === "employee");
  const mineDone = mineSections.length > 0 && mineSections.every((x) => sectionDone(task, x.position, x.side));
  const subs = (task.subtasks ?? []).filter((x) => sideOf(x.form_section?.assignee_type ?? x.assignee_type) === "employee");
  const percent = mineDone
    ? 100
    : subs.length > 0
      ? Math.round(subs.reduce((sum, x) => sum + percentOf(x.progress?.percent), 0) / subs.length)
      : percentOf(task.progress?.percent);
  return {
    id: task.id,
    formId: task.form_id,
    name: form?.short ?? task.name,
    status: task.status,
    percent,
    next: task.next_action?.type ?? null,
    dueAt: task.due_at ?? null,
    mineDone,
    mine: mineSections.length > 0,
    updatedAt: task.updated_at ?? null,
  };
}

const sectionDone = (task: ObTask, position: number, side: Side): boolean => {
  if (task.status === "completed") return true;
  const subs = (task.subtasks ?? []).filter(
    (s) => (s.form_section?.position ?? 1) === position,
  );
  if (subs.length === 0) return false;
  const allFilled = subs.every((s) => (s.progress?.percent ?? 0) >= 1);
  if (allFilled) return true;
  // The task has moved past the employee's part once it waits on the employer.
  return side === "employee" && task.next_action?.type === "employer_action";
};

function rowsFor(tasks: ObTask[], ctx: AccountContext, order: string[]): HireRow[] {
  const byForm = new Map(tasks.map((t) => [t.form_id, t]));
  const rows: HireRow[] = [];
  for (const formId of order) {
    const task = byForm.get(formId);
    const form = ctx.forms[formId];
    if (!task || !form) continue;
    let earlierDone = true;
    for (const section of form.sections) {
      const done = sectionDone(task, section.position, section.side);
      const open = !done && earlierDone;
      rows.push({
        id: `${task.id}:${section.position}`,
        title: stepTitle(form, section),
        side: section.side,
        state: done ? "done" : open ? "open" : "not_started",
        note: done
          ? sideLabel[section.side]
          : open
            ? `${section.side === "employer" ? "In review" : "To do"} · ${sideLabel[section.side]}`
            : sideLabel[section.side],
      });
      earlierDone = earlierDone && done;
    }
  }
  return rows;
}

interface CreateHireInput {
  facts: Facts;
  /** Form ids in the order the check listed them. */
  formOrder: string[];
}

/** Approve: update the employee, create the placement with its tasks, set due dates, get the link. */
export async function createHire(
  config: OnboardedConfig,
  ctx: AccountContext,
  input: CreateHireInput,
  counter: CallCounter = newCounter(),
): Promise<HireRecord> {
  const { facts } = input;

  const employeePatch: Record<string, unknown> = {};
  if (facts.first_name) employeePatch.first_name = facts.first_name;
  if (facts.last_name) employeePatch.last_name = facts.last_name;
  if (Object.keys(employeePatch).length > 0) {
    await ob(config, counter, "PATCH", `/employees/${ctx.employeeId}`, employeePatch, {
      detail: "What the interview learned goes onto the employee, so forms start prefilled",
      returned: (b) => {
        const e = b as { id?: string; first_name?: string; last_name?: string };
        return [
          `id: ${shortValue(e.id)}`,
          `first_name: ${shortValue(e.first_name)}`,
          `last_name: ${shortValue(e.last_name)}`,
        ];
      },
      result: () => "employee updated",
    });
  }

  const body: Record<string, unknown> = { employee_id: ctx.employeeId, create_tasks: true };
  if (ctx.employerId) body.employer_id = ctx.employerId;
  if (ctx.jobId) body.job_id = ctx.jobId;
  if (facts.work_location) body.client_id = facts.work_location;
  if (facts.start_date) body.custom_attributes = { start_date: facts.start_date };
  // Onboarded keeps one placement per employee, job and work site. A retried start_paperwork (after a
  // partial failure) or a hire already made by Approve gets 409 "Placement already exists": the hire is
  // then the one that exists, with the tasks it already has.
  const placement = await ob<ObPlacement>(config, counter, "POST", "/placements", body, {
    detail: "Create the hire. The account's policies run and the tasks are created.",
    returned: (b) => {
      const made = b as ObPlacement;
      return [
        `id: ${shortValue(made.id)}`,
        `form_requirements: [${(made.form_requirements ?? []).length}]`,
        ...(made.form_requirements ?? []).map((r) => `  ${r.form.name}: ${shortValue(r.task_id)}`),
      ];
    },
    result: (b) => {
      const made = b as ObPlacement;
      return `${(made.form_requirements ?? []).filter((r) => r.task_id).length} tasks created`;
    },
  }).catch(async (error: unknown) => {
    if (!/409|already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    const found = await ob<{ data?: ObPlacement[] }>(config, counter, "GET", `/placements?employee_id=${encodeURIComponent(ctx.employeeId ?? "")}`, undefined, {
      detail: "This person was already hired for this job: read the placement that exists, and carry on with its forms.",
      returned: (b) => ((b as { data?: ObPlacement[] }).data ?? []).map((made) => `id: ${shortValue(made.id)}, ${(made.form_requirements ?? []).length} forms`),
      result: (b) => `${((b as { data?: ObPlacement[] }).data ?? []).length} placement${((b as { data?: ObPlacement[] }).data ?? []).length === 1 ? "" : "s"} on file`,
    });
    const same = (found.data ?? []).filter(
      (made) => (!ctx.jobId || made.job_id === ctx.jobId) && (!facts.work_location || made.client_id === facts.work_location),
    );
    const existing = same.find((made) => (made.form_requirements ?? []).some((r) => r.task_id)) ?? same[0];
    if (!existing) throw error;
    return existing;
  });
  const requirements = placement.form_requirements ?? [];
  await ensureForms(
    config,
    counter,
    ctx,
    requirements.map((r) => r.form),
  );

  // Due dates: the account's deadline rule for the employee's part, counted from the start date.
  if (facts.start_date) {
    await Promise.all(
      requirements.map(async (r) => {
        const form = ctx.forms[r.form.id];
        const days = form ? num(form.attrs.employee_due_days_from_start) : null;
        if (r.task_id === null || days === null) return;
        const due = addDays(facts.start_date as string, days);
        await ob(config, counter, "PATCH", `/tasks/${r.task_id}`, { due_at: `${due}T23:59:59.000Z` }, {
          detail: `Due date for ${form?.short ?? "the form"}, from the deadline rule stored on the form`,
          returned: (b) => {
            const t = b as { id?: string; name?: string; due_at?: string; status?: string };
            return [`id: ${shortValue(t.id)}`, `name: ${shortValue(t.name)}`, `due_at: ${shortValue(t.due_at)}`, `status: ${shortValue(t.status)}`];
          },
          result: () => `due ${shortDay(due)}`,
        });
      }),
    );
  }

  const taskIds = requirements.map((r) => r.task_id).filter((t): t is string => t !== null);
  // The hosted page shows a link's tasks in an order of its own unless the link names them.
  // A link made with task_ids shows them in exactly that order, which is how the session knows
  // which form opens first. The order is the check's, the same as the requirements table.
  const place = (formId: string): number => {
    const at = input.formOrder.indexOf(formId);
    return at === -1 ? input.formOrder.length : at;
  };
  const inOrder = [...requirements]
    .sort((a, b) => place(a.form.id) - place(b.form.id))
    .map((r) => r.task_id)
    .filter((t): t is string => t !== null);
  let linkOrder: string[] | undefined;
  let link: { url?: string } | null = null;
  if (inOrder.length > 0) {
    try {
      link = await ob<{ url?: string }>(config, counter, "GET", `/employees/${ctx.employeeId}/onboarding?task_ids=${inOrder.join(",")}`, undefined, {
        detail: "The candidate's hosted onboarding link, with the forms in a set order: no app, no password",
        result: () => `link created, ${inOrder.length} forms in order`,
      });
      linkOrder = inOrder;
    } catch {
      // The account's own form sequence refused that order: take the link as the account orders it.
      link = null;
    }
  }
  link ??= await ob<{ url?: string }>(config, counter, "GET", `/employees/${ctx.employeeId}/onboarding`, undefined, {
    detail: "The candidate's hosted onboarding link: no app, no password",
    result: () => "link created",
  });
  const now = new Date().toISOString();
  const record: HireRecord = {
    placementId: placement.id,
    employeeId: ctx.employeeId,
    taskIds,
    startedAt: now,
    readyAt: null,
    startDate: facts.start_date ?? null,
    onboardingUrl: link.url ?? null,
    employerUrl: null,
    events: [],
    rows: [],
    polledAt: null,
    ...(linkOrder ? { linkOrder } : {}),
  };
  const refreshed = await refreshHire(config, ctx, record, input.formOrder, true, counter);
  refreshed.events = [
    { at: now, text: `placement.created · ${refreshed.rows.length} tasks` },
    { at: now, text: "onboarding forms opened on the candidate's screen" },
  ];
  return refreshed;
}

/** Reads the hire's tasks and appends an event for each change since the last read. */
export async function refreshHire(
  config: OnboardedConfig,
  ctx: AccountContext,
  record: HireRecord,
  formOrder: string[],
  force = false,
  /** The caller's log. A poll that finds nothing new is left out of it. */
  log: CallCounter | null = null,
): Promise<HireRecord> {
  const now = new Date();
  if (!force && record.polledAt !== null && now.getTime() - Date.parse(record.polledAt) < 1500) {
    return record;
  }
  if (record.readyAt !== null && !force) return record;

  const counter = newCounter();
  const tasks = await Promise.all(
    record.taskIds.map((id) => ob<ObTask>(config, counter, "GET", `/tasks/${id}`)),
  );
  const known = new Set(formOrder);
  const order = [...formOrder, ...tasks.map((t) => t.form_id).filter((f) => !known.has(f))];
  const rows = rowsFor(tasks, ctx, order);

  const doneBefore = record.rows.filter((r) => r.state === "done").length;
  const done = rows.filter((r) => r.state === "done").length;
  const events = [...record.events];
  const at = now.toISOString();
  for (let n = doneBefore + 1; n <= done; n += 1) {
    events.push({ at, text: `task.updated · ${n} of ${rows.length} complete` });
  }
  const ready = rows.length > 0 && done === rows.length;
  let readyAt = record.readyAt;
  if (ready && readyAt === null) {
    readyAt = at;
    events.push({ at, text: "placement.updated · ready" });
  }

  // The employer's link, once their part is the open one.
  let employerUrl = record.employerUrl;
  const employerOpen = rows.find((r) => r.side === "employer" && r.state === "open");
  if (employerOpen && employerUrl === null) {
    const taskId = employerOpen.id.split(":")[0];
    try {
      const link = await ob<{ url?: string }>(
        config,
        counter,
        "GET",
        `/tasks/${taskId}/onboarding?assignee_type=employer`,
        undefined,
        { detail: "The employer's link for their part of the form", result: () => "link created", returned: () => ["url: the employer's link (not logged)"] },
      );
      employerUrl = link.url ?? null;
    } catch {
      employerUrl = null;
    }
  }
  if (!employerOpen) employerUrl = null;

  // The rail shows one line per change, not one per poll.
  if (log && (force || done !== doneBefore || employerUrl !== record.employerUrl)) {
    const sample = counter.calls.find((c) => c.path.startsWith("/tasks/") && !c.path.includes("onboarding"));
    if (sample) {
      log.calls.push({
        ...sample,
        path: "/tasks/{id}",
        detail: `Follow the hire: one read per task (${record.taskIds.length}), every 1.5 s`,
        sent: [],
        returned: tasks.map((t) => {
          const form = ctx.forms[t.form_id];
          return `${form?.short ?? t.name}: ${t.status}${t.next_action?.type ? ` · next: ${t.next_action.type}` : ""}`;
        }),
        result: ready ? `${done} of ${rows.length} complete · ready` : `${done} of ${rows.length} complete`,
      });
    }
    log.calls.push(...counter.calls.filter((c) => c.path.includes("onboarding")));
    log.n += counter.n;
  }
  const byForm = new Map(tasks.map((t) => [t.form_id, t]));
  const before = new Map((record.tasks ?? []).map((t) => [t.id, t]));
  const snaps = order.flatMap((formId) => {
    const task = byForm.get(formId);
    if (!task) return [];
    const snap = snapOf(task, ctx.forms[formId]);
    const was = before.get(task.id);
    return [{ ...snap, from: was?.from ?? was?.percent ?? snap.percent, updated0: was ? (was.updated0 ?? was.updatedAt ?? null) : snap.updatedAt }];
  });
  return { ...record, rows, events, readyAt, employerUrl, polledAt: at, tasks: snaps };
}

// -- The requirements table and reading a form ------------------------------------------------

/** Where a form comes from, when the account says so: a form tag, or a `source` form attribute. */
function sourceOf(form: FormInfo | undefined): FormSource | null {
  const said = [...(form?.tags ?? []), text(form?.attrs.source) ?? ""].map((t) => t.toLowerCase());
  if (said.some((t) => t.includes("integration"))) return "integration";
  if (said.some((t) => t.includes("custom"))) return "custom";
  if (said.some((t) => t.includes("library"))) return "library";
  return null;
}

const monthDay = (iso: string): string => shortDay(iso).split(", ")[1] ?? iso;

/** The placement's forms as the watch view lists them: where each comes from, whose turn it is, how far along. */
export function agentFormsOf(record: HireRecord, ctx: AccountContext, who: { first: string; employer: string }): AgentForm[] {
  const hand = taskInHand(record, ctx, null);
  return (record.tasks ?? []).map((task) => {
    const form = ctx.forms[task.formId];
    const employerPart = form?.sections.some((x) => x.side === "employer") ?? false;
    const done = task.status === "completed";
    const started = task.percent > (task.from ?? 0);
    const state: AgentForm["state"] = done ? "done" : task.mineDone ? "part" : started ? "open" : "todo";
    const status = done
      ? "Complete"
      : task.mineDone
        ? `${who.first}'s part done`
        : started
          ? `In progress, ${task.percent}%`
          : !task.mine
            ? `Waiting on ${who.employer}`
            : "Not started";
    const mineDays = form ? num(form.attrs.employee_due_days_from_start) : null;
    const theirDays = form ? num(form.attrs.employer_due_business_days_from_start) : null;
    const start = record.startDate;
    const mineDue = start !== null && mineDays !== null ? monthDay(addDays(start, mineDays)) : task.dueAt ? monthDay(task.dueAt.slice(0, 10)) : null;
    const theirDue = start !== null && theirDays !== null && employerPart ? monthDay(addBusinessDays(start, theirDays)) : null;
    return {
      taskId: task.id,
      formId: task.formId,
      name: task.name,
      note: text(form?.attrs.applies_when) ? `Applies because the ${text(form?.attrs.applies_when)}` : (text(form?.attrs.summary)?.split(". ")[0] ?? null),
      source: sourceOf(form),
      whose: !task.mine ? who.employer : employerPart ? (task.mineDone ? who.employer : `${who.first}, then ${who.employer}`) : who.first,
      status,
      state,
      percent: task.percent,
      due: mineDue && theirDue ? `${who.first}: ${mineDue} · ${who.employer}: ${theirDue}` : (mineDue ?? theirDue),
      now: hand !== null && hand.id === task.id && !task.mineDone,
    };
  });
}

/** Before the hire: the forms Onboarded's dry run lists for the answers so far, in the same table. */
export function previewFormsOf(
  check: RequirementsCheck | null,
  ctx: AccountContext,
  who: { first: string; employer: string },
  startDate: string | null,
): AgentForm[] {
  const ids = [...new Set((check?.steps ?? []).map((x) => x.formId))];
  const tasks: TaskSnap[] = ids.map((formId) => {
    const form = ctx.forms[formId];
    return {
      id: `preview:${formId}`,
      formId,
      name: form?.short ?? "Form",
      status: "preview",
      percent: 0,
      next: null,
      dueAt: null,
      mineDone: false,
      mine: form?.sections.some((x) => x.side === "employee") ?? true,
    };
  });
  const pretend = { tasks, startDate } as unknown as HireRecord;
  // No form is on the candidate's screen before the hire: the marker waits for the real tasks.
  return agentFormsOf(pretend, ctx, who).map((form) => ({ ...form, status: "After the offer", now: false }));
}

/** Form text as plain words: no images, no markup. */
const plain = (raw: string): string =>
  raw
    .replace(/<img[^>]*>/gi, " ")
    // The form's own template code (it fills in the summary page) is not text for a person.
    .replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\*{1,3}|_{2,3}|^#{1,6}\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

/** Fields whose values are never read back to the voice agent, whatever the API would return. */
const NEVER_READ =
  /social_security|ssn|tax_id|ein\b|date_of_birth|birth|dob\b|bank|routing|account_number|signature|passport|license|document|citizen|alien|uscis|i_?94|immigration|visa|work_authorization|admission_number|expiration/i;

const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The task the candidate means: the form they named, else the one on their screen.
 *
 * Which form is on screen is worked out from two things the public API gives. The hosted page
 * moves a task's updated_at each time one of its pages loads or is saved, so among the forms
 * the candidate has not finished, the one that moved last is the one they are on. Before any
 * has moved, it is their first unfinished form in the link's order (the link is made with
 * task_ids, so that order is the session's own). Onboarded's page cannot tell a parent page
 * where the candidate is: its messages go to its own origin only.
 */
export function taskInHand(record: HireRecord, ctx: AccountContext, named: string | null): TaskSnap | null {
  const mine = (record.tasks ?? []).filter((t) => t.mine);
  if (named && squash(named) !== "") {
    const want = squash(named);
    const hit = mine.find((t) => {
      const form = ctx.forms[t.formId];
      const names = [t.name, form?.name ?? "", form?.short ?? ""].map(squash).filter(Boolean);
      return names.some((n) => n.includes(want) || want.includes(n));
    });
    if (hit) return hit;
  }
  const open = mine.filter((t) => !t.mineDone);
  const moved = open
    .filter((t) => t.updatedAt != null && t.updatedAt !== (t.updated0 ?? t.updatedAt))
    .sort((a, b) => (b.updatedAt as string).localeCompare(a.updatedAt as string));
  return moved[0] ?? open.find((t) => t.percent > (t.from ?? 0)) ?? open[0] ?? mine.at(-1) ?? null;
}

/**
 * What Ava hears when she reads a form: what each of the candidate's pages says, the choices
 * on it, and what the candidate has entered so far. Two public API reads; values of sensitive
 * fields are asked for masked and are left out here as well.
 */
export async function readFormForAva(
  config: OnboardedConfig,
  counter: CallCounter,
  ctx: AccountContext,
  task: TaskSnap,
  /** Where this form stands: whether it is the one on screen, and the order of the others. */
  where = "",
): Promise<string> {
  const [form, entered] = await Promise.all([
    ob<ObForm>(config, counter, "GET", `/forms/${task.formId}`, undefined, {
      detail: `${task.name}: the form's own pages, to answer the candidate's question from`,
      returned: (b) => {
        const pages = ((b as ObForm).form_pages ?? []).filter((pg) => sideOf(pg.form_section?.assignee_type ?? pg.assignee_type) === "employee");
        return [`name: ${(b as ObForm).name}`, `form_pages: ${pages.length} for the employee`, ...pages.map((pg) => `  ${pg.description ?? "page"}: ${(pg.form_fields ?? []).length} fields`)];
      },
      result: () => "page text and field labels",
    }),
    ob<{ fields?: Array<{ type?: string; path?: string; label?: Record<string, string | null> | null; value?: unknown; submitted_at?: string | null }> }>(
      config,
      counter,
      "GET",
      `/tasks/${task.id}/fields?include_sensitive_info=false`,
      undefined,
      {
        detail: `What the candidate has entered on ${task.name} so far, without sensitive values`,
        returned: (b) => {
          const fields = (b as { fields?: Array<{ value?: unknown }> }).fields ?? [];
          return [`fields: [${fields.length}]`, `with a value: ${fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "").length}`];
        },
        result: (b) => {
          const fields = (b as { fields?: Array<{ value?: unknown }> }).fields ?? [];
          return `${fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== "").length} answers so far`;
        },
      },
    ).catch(() => ({ fields: [] })),
  ]);

  const lines: string[] = [];
  const pages = (form.form_pages ?? []).filter((pg) => sideOf(pg.form_section?.assignee_type ?? pg.assignee_type) === "employee");
  pages.forEach((page, i) => {
    lines.push(`Page ${i + 1} of ${pages.length}${page.description ? `: ${page.description}` : ""}`);
    for (const field of page.form_fields ?? []) {
      const en = field.translations?.en ?? {};
      if (field.type === "content") {
        const words = plain(en.content ?? "");
        if (words !== "") lines.push(words.slice(0, 900));
        continue;
      }
      const label = plain(en.label ?? "");
      if (label === "") continue;
      const options = Object.entries(en)
        .filter(([key]) => /^options>.*>label$/.test(key))
        .map(([, value]) => plain(value));
      lines.push(`- Question: ${label}${options.length ? ` Choices: ${options.join(" | ")}.` : ""}${field.required ? "" : " (optional)"}`);
    }
  });

  const answers = (entered.fields ?? [])
    .filter((f) => f.value !== null && f.value !== undefined && f.value !== "" && !NEVER_READ.test(`${f.path ?? ""} ${f.type ?? ""}`))
    .flatMap((f) => {
      // Of the values that are objects only an address is read back, as its one line. Any
      // other composite could hold something that is not Ava's to say.
      const address = f.value as { full_address?: string; fullAddress?: string } | null;
      const value = typeof f.value === "object" ? (address?.full_address ?? address?.fullAddress ?? null) : String(f.value);
      return value === null ? [] : [`- ${plain(f.label?.en ?? f.path ?? "field")}: ${value.slice(0, 120)}`];
    })
    .slice(0, 30);

  const formInfo = ctx.forms[task.formId];
  return [
    `Form: ${task.name}${formInfo && formInfo.name.trim() !== task.name ? ` (${formInfo.name.trim()})` : ""}. ${task.mineDone ? "The candidate has finished their part of it." : task.percent > (task.from ?? 0) ? `The candidate is ${task.percent}% through it.` : "The candidate has not started it yet."}`,
    ...(where ? [where] : []),
    "What the form says:",
    lines.join("\n").slice(0, 6500),
    answers.length ? `What the candidate has entered so far:\n${answers.join("\n")}` : "The candidate has not entered anything on it yet.",
    "Answer their question in one or two sentences, only from the form's own words above. Do not choose for them. If the form does not cover it, say so.",
  ].join("\n");
}

export const hireStatusOf = (record: HireRecord): HireStatus => {
  const done = record.rows.filter((r) => r.state === "done").length;
  return {
    placementId: record.placementId,
    employeeId: record.employeeId,
    rows: record.rows,
    done,
    total: record.rows.length,
    ready: record.readyAt !== null,
    startedAt: record.startedAt,
    readyAt: record.readyAt,
    startDate: record.startDate,
    events: record.events,
    onboardingUrl: record.onboardingUrl,
    employerUrl: record.employerUrl,
  };
};
