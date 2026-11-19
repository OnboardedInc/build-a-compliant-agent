import { Hono, type MiddlewareHandler } from "hono";
import { nanoid } from "nanoid";
import type { AppContext, AppEnv } from "../index";
import { AGENT_NAME_MAX, FACE_COUNT, DEFAULT_BRAND, workEmailProblem, type Brand, type BuilderView, type FieldError, type ScreeningQuestion, type StartResponse } from "../../shared/builder";
import { brandFor, safeDomain } from "../services/brand";
import { sendVerification } from "../services/email";
import { writeQuestions } from "../services/questions";
import { publicBase } from "../services/security";
import { wallOn } from "../services/access";

export interface BuilderRow {
  id: string; token: string; email: string; company: string; website: string; brand: string;
  verify_token: string | null; verify_sent_at: string | null; verified_at: string | null;
  description: string | null; job_title: string | null; questions: string;
  agent_name: string | null; agent_face: number | null; built_at: string | null;
  created_at: string; updated_at: string;
}
export const builderOf = (c: AppContext): BuilderRow => c.get("builder");
const now = () => new Date().toISOString();
const questionsOf = (row: BuilderRow): ScreeningQuestion[] => JSON.parse(row.questions) as ScreeningQuestion[];
const read = (c: AppContext, id: string) => c.env.DB.prepare("SELECT * FROM builders WHERE id = ?").bind(id).first<BuilderRow>();
const value = (input: unknown): string => typeof input === "string" ? input.trim() : "";
const problem = (c: AppContext, errors: FieldError[]) => c.json({ error: "Check the highlighted fields.", errors }, 400);

export const builderAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") || "")?.[1];
  const row = token ? await c.env.DB.prepare("SELECT * FROM builders WHERE token = ?").bind(token).first<BuilderRow>() : null;
  if (!row || wallOn(c.env) && row.email.toLowerCase() !== c.get("accessEmail")) return c.json({ error: "Unauthorized" }, 401);
  c.set("builder", row);
  return next();
};
const confirmed: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!builderOf(c).verified_at) return c.json({ error: "Confirm your email first." }, 403);
  return next();
};
async function verificationUrl(c: AppContext, row: BuilderRow): Promise<string> {
  return `${await publicBase(c.env.DB, c.req.url)}/verify?token=${encodeURIComponent(row.verify_token!)}`;
}
async function view(c: AppContext, row: BuilderRow): Promise<BuilderView> {
  const questions = questionsOf(row);
  const verified = !!row.verified_at;
  const named = !!row.agent_name && row.agent_face !== null;
  return {
    id: row.id, email: row.email, company: row.company, website: row.website,
    brand: JSON.parse(row.brand) as Brand || DEFAULT_BRAND,
    verified, description: row.description, jobTitle: row.job_title, questions,
    agentName: row.agent_name, agentFace: row.agent_face, built: !!row.built_at,
    step: !verified ? "email" : questions.length !== 2 ? "questions" : !named ? "name" : "built",
    // Local development only, and only to a request made on this machine: the tunnel address
    // reaches the same Worker from the internet, and must not hand out the link.
    ...(c.env.DEV_SHOW_VERIFY_LINK === "1" && row.verify_token && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(c.req.url).hostname) ? { devVerifyUrl: await verificationUrl(c, row) } : {}),
  };
}
/** How many times a day one email address can be sent a link, across every start. */
const MAX_STARTS_PER_EMAIL = 3;

/**
 * Topics a screening question must not ask about. The model that writes the questions is told
 * the same; this catches a question the visitor edits by hand. It is a word list, not a legal
 * review: it stops the obvious ones.
 */
const PROTECTED = /\b(how old|your age|date of birth|birth ?date|born|pregnan|marital|married|spouse|husband|wife|children|kids|child ?care|religio|church|mosque|synagogue|citizen|national origin|nationality|where (are|were) you from|race|ethnic|disab|medical|health condition|medication|arrest|convict|criminal|salary history|current (salary|pay)|social security|ssn)\b/i;

export const builders = new Hono<AppEnv>();
builders.post("/builders", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const internal = wallOn(c.env);
  const signedInEmail = c.get("accessEmail");
  if (internal && !signedInEmail) return c.json({ error: "Unauthorized" }, 401);
  const suppliedEmail = value(body?.email).toLowerCase();
  const email = internal ? signedInEmail : suppliedEmail;
  const company = value(body?.company);
  const website = safeDomain(value(body?.website));
  const errors: FieldError[] = [];
  const emailError = internal ? (suppliedEmail && suppliedEmail !== signedInEmail ? `Use the Google address you signed in with: ${signedInEmail}.` : null) : workEmailProblem(email);
  if (emailError) errors.push({ field: "email", message: emailError });
  else if (email.length > 254) errors.push({ field: "email", message: "Enter a valid email address." });
  if (company.length < 2 || company.length > 80) errors.push({ field: "company", message: "Use 2 to 80 characters." });
  if (!website) errors.push({ field: "website", message: "Enter a public company domain." });
  if (errors.length) return problem(c, errors);
  // The public flow limits emails sent; the internal flow sends no verification mail.
  if (!internal) {
    const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM builders WHERE email = ? AND created_at > ?").bind(email, new Date(Date.now() - 86_400_000).toISOString()).first<{ n: number }>();
    if ((recent?.n ?? 0) >= MAX_STARTS_PER_EMAIL) return c.json({ error: "A link was already sent to this address today. Open it, or try again tomorrow." }, 429);
  }
  const at = now();
  const id = `bld_${nanoid(12)}`;
  const token = nanoid(32);
  const verifyToken = internal ? null : nanoid(32);
  const brand = await brandFor(website!, c.env);
  await c.env.DB.prepare(`INSERT INTO builders
    (id, token, email, company, website, brand, verify_token, verify_sent_at, verified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, token, email, company, website, JSON.stringify(brand), verifyToken, internal ? null : at, internal ? at : null, at, at).run();
  const row = (await read(c, id))!;
  const emailSent = internal ? false : await sendVerification(c.env, email, await verificationUrl(c, row));
  return c.json({ token, builder: await view(c, row), emailSent } satisfies StartResponse & { emailSent: boolean }, 201);
});
builders.post("/verify", async (c) => {
  const body = await c.req.json<{ token?: unknown }>();
  const token = value(body?.token);
  // Consume and confirm in one statement: the same link cannot succeed on two devices.
  const row = token ? await c.env.DB.prepare("UPDATE builders SET verified_at = ?, verify_token = NULL, updated_at = ? WHERE verify_token = ? AND verified_at IS NULL RETURNING *").bind(now(), now(), token).first<BuilderRow>() : null;
  if (!row) return c.json({ error: "This verification link is unknown or has already been used." }, 404);
  return c.json({ token: row.token, builder: await view(c, row) } satisfies StartResponse);
});
builders.use("/me", builderAuth);
builders.use("/me/*", builderAuth);
builders.get("/me", async (c) => c.json(await view(c, builderOf(c))));
builders.post("/me/verify/resend", async (c) => {
  const previous = builderOf(c);
  if (previous.verified_at) return c.json({ error: "Your email is already confirmed." }, 409);
  const at = now();
  // Claim the send before sending: concurrent clicks cannot bypass the cooldown.
  const row = await c.env.DB.prepare(`UPDATE builders SET verify_token = ?, verify_sent_at = ?, updated_at = ?
    WHERE id = ? AND verified_at IS NULL AND (verify_sent_at IS NULL OR verify_sent_at <= ?) RETURNING *`)
    .bind(nanoid(32), at, at, previous.id, new Date(Date.now() - 30_000).toISOString()).first<BuilderRow>();
  if (!row) return c.json({ error: "Wait 30 seconds before sending another link." }, 429);
  const emailSent = await sendVerification(c.env, row.email, await verificationUrl(c, row));
  return c.json({ ...await view(c, row), emailSent });
});
builders.post("/me/questions", confirmed, async (c) => {
  const body = await c.req.json<{ description?: unknown }>();
  const description = value(body?.description);
  if (description.length < 20 || description.length > 1500) return problem(c, [{ field: "description", message: "Describe the role in 20 to 1500 characters." }]);
  try {
    const { questions, jobTitle } = await writeQuestions(c.env.VAPI_PRIVATE_KEY, description);
    await c.env.DB.prepare("UPDATE builders SET description = ?, job_title = ?, questions = ?, updated_at = ? WHERE id = ?").bind(description, jobTitle, JSON.stringify(questions), now(), builderOf(c).id).run();
    return c.json(await view(c, (await read(c, builderOf(c).id))!));
  } catch { return c.json({ error: "The questions could not be written. Try again." }, 502); }
});
builders.put("/me", confirmed, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Send an update object." }, 400);
  const row = builderOf(c);
  const errors: FieldError[] = [];
  let questions = questionsOf(row);
  let agentName = row.agent_name;
  let agentFace = row.agent_face;
  if (body.questions !== undefined) {
    const input = body.questions;
    if (!Array.isArray(input) || input.length !== 2 || questions.length !== 2 || new Set(input.map((q) => q?.id)).size !== 2 || !input.every((q) => q && questions.some((old) => old.id === q.id) && typeof q.question === "string" && q.question.trim().length >= 10 && q.question.trim().length <= 240)) {
      errors.push({ field: "questions", message: "Edit the same two questions, using 10 to 240 characters each." });
    } else if (input.some((q) => PROTECTED.test(q.question))) {
      errors.push({ field: "questions", message: "A screening question cannot ask about age, family, health, religion, citizenship, criminal history or pay history. Ask about the job instead." });
    } else questions = questions.map((q) => ({ ...q, question: value(input.find((edited) => edited.id === q.id).question) }));
  }
  if (body.agentName !== undefined) {
    const name = value(body.agentName);
    if (name.length < 1 || name.length > AGENT_NAME_MAX || !/^[\p{L}\p{N} '\-]+$/u.test(name)) errors.push({ field: "agentName", message: "Use 1 to 8 letters, digits, spaces, hyphens or apostrophes." });
    else agentName = name;
  }
  if (body.agentFace !== undefined) {
    if (typeof body.agentFace !== "number" || !Number.isInteger(body.agentFace) || body.agentFace < 1 || body.agentFace > FACE_COUNT) errors.push({ field: "agentFace", message: "Choose a face from 1 to 10." });
    else agentFace = body.agentFace;
  }
  if (errors.length) return problem(c, errors);
  // Only write fields present in this update: question and name autosaves can overlap.
  const sets: string[] = []; const values: (string | number | null)[] = [];
  if (body.questions !== undefined) { sets.push("questions = ?"); values.push(JSON.stringify(questions)); }
  if (body.agentName !== undefined) { sets.push("agent_name = ?"); values.push(agentName); }
  if (body.agentFace !== undefined) { sets.push("agent_face = ?"); values.push(agentFace); }
  if (sets.length) await c.env.DB.prepare(`UPDATE builders SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...values, now(), row.id).run();
  return c.json(await view(c, (await read(c, row.id))!));
});
builders.post("/me/build", confirmed, async (c) => {
  const row = builderOf(c);
  const errors: FieldError[] = [];
  if (questionsOf(row).length !== 2) errors.push({ field: "questions", message: "Write your two screening questions first." });
  if (!row.agent_name) errors.push({ field: "agentName", message: "Name your agent first." });
  if (!row.agent_face) errors.push({ field: "agentFace", message: "Choose your agent's face first." });
  if (errors.length) return problem(c, errors);
  await c.env.DB.prepare("UPDATE builders SET built_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), row.id).run();
  return c.json(await view(c, (await read(c, row.id))!));
});
