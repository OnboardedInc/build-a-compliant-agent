# buildacompliantagent.com: spec

A site by Onboarded. A visitor builds their own AI screening agent in four steps, then takes a call with it as a candidate and watches what Onboarded does behind the call. The call screens the candidate, makes an offer, and has them fill in Onboarded's hosted onboarding forms on the same call.

This file describes the first version: what the visitor does, the API, the call, and the look. `CLAUDE.md` covers working in the code.

## 1. What the visitor does

1. **Company** (`/`). Work email, company name, company website. On Continue the server saves them, finds the logo and two colours for the domain, and sends a one-time link to the email. A personal address (gmail.com and the like) is refused at the field.
2. **Confirm email** (`/check-email`). The page waits. When the link is opened (on any device) it carries on to step 3. Nothing past step 2 works until the email is confirmed.
3. **Questions** (`/questions`). The visitor types or says what they screen for. The server turns it into exactly two screening questions, each with the topic it is scored as, and reads a job title out of the description. The visitor may edit the wording of either question, or describe again.
4. **Name and face** (`/name`). An agent name of 1 to 8 characters and one of 10 faces.
5. **Built** (`/built`). The four parts arrive one at a time (brand, two questions, name and face, compliance by Onboarded), then a button: "Take a test call".
6. **The call** (`/call`). Left: the candidate's phone in the visitor's brand. Right: what a recruiter watches, in Onboarded's branding. The visitor presses Start, talks to their agent, gets an offer, and fills in Onboarded's hosted forms on the same call.

The call itself, in order:

1. The agent greets them by its name and the visitor's company.
2. "Which city would you want to work in?" (the Onboarded account's work sites, cities only). The agent calls `get_requirements` and says how many forms that site needs after an offer.
3. "What is your full legal name?"
4. Screening question 1, then screening question 2 (the visitor's own).
5. The agent calls `request_offer`. At a fit score of 80 or above it makes the offer, naming the start date. Under 80 it closes politely and the watch view shows "Approve offer".
6. On "yes" the agent calls `start_paperwork`: the hire is created in Onboarded and its hosted onboarding page opens on the candidate's screen, under the call. The agent waits silently, answers questions about a form by reading it (`read_form`), and says when each form is done.
7. When the candidate's forms are done the agent says so, takes any last question and ends the call. The watch view's last step is **Ready** (every form done, the employer's part included). There is no payroll step anywhere.

There is no email question, no start-date question and no `check_start_date` tool: the offered start date is fixed when the session is made (`offeredStartFrom(today)`) and written to the facts then, so the call reaches the offer quickly.

## 2. Architecture

One Cloudflare Worker serves the API (Hono) and the React SPA as static assets, with one D1 database.

```
src/shared/    types and pure helpers used by both sides (builder.ts, interview.ts)
src/server/    the Worker: index.ts, endpoints/, services/
src/app/       the React 19 SPA (Vite, Tailwind v4, react-router)
migrations/    D1 schema (0001_init.sql)
scripts/       voice-tunnel.mjs (local public address for Vapi's webhooks)
tests/         browser and spoken-call tests against a running dev server
```

Ports: Worker 8788, Vite 5176 (`/api` is proxied to the Worker), cloudflared's status page 20248.

### Configuration (env, never the database)

`.dev.vars` locally, wrangler secrets when deployed. `src/server/index.ts` declares them on the Hono `Bindings` type.

| Name | What |
|---|---|
| `ONBOARDED_API_BASE`, `ONBOARDED_API_KEY` | The one Onboarded account every visitor's agent runs against (public API). The base defaults to `https://app.onboarded.com/api/v1`. |
| `ONBOARDED_EMPLOYER_ID`, `ONBOARDED_JOB_ID` | The employer and job in that account that placements use. A job Onboarded does not know is retried without the job. |
| `VAPI_PRIVATE_KEY`, `VAPI_ORG_ID` | Voice calls, and Vapi's chat API for the note-taker and for writing the questions. If the org id is missing, it is read from Vapi once and kept in `settings` (`vapi_org_id`). |
| `BRAND_DEV_API_KEY` | Optional. Logo and colours from brand.dev. Without it the Worker reads the company's own home page. |
| `ADMIN_TOKEN` | Bearer token for `/api/admin/*`. |
| `DEV_SHOW_VERIFY_LINK` | `"1"` locally: `BuilderView.devVerifyUrl` carries the one-time link. Never set when deployed. |
| `EMAIL` (binding), `EMAIL_FROM`, `SITE_NAME` | Cloudflare Email Sending. `await env.EMAIL.send({ to, from, subject, html, text })`. A failed send is logged and reported in the response as `emailSent: false`; it never blocks the step. |

The public address Vapi posts to: `settings.public_url` when set (the tunnel script saves it in local dev), else the request's own origin. A session link for a phone uses the same address.

### Data model

`migrations/0001_init.sql`: `builders`, `interview_sessions`, `settings`. Ids: `bld_` + nanoid(12), `int_` + nanoid(12). Tokens: nanoid(32). Timestamps: ISO 8601.

`interview_sessions` is keyed by `builder_id`. `link_token` is always set. Its JSON columns `base`, `work`, `transcript` and `hire` each have one kind of writer, so the webhook and the browser never overwrite each other. `call` holds the call's own state, including Vapi's control URL, which is never sent to the browser. `base` holds what the call needs from the builder at the moment the session is made (a later edit of the agent does not change a session):

```ts
interface Base {
  company: string;            // the employer the agent speaks for
  jobTitle: string;           // "Banquet server"; "the role" when the description named none
  agentName: string;
  agentFace: number;
  brand: Brand;
  questions: ScreeningQuestion[];   // exactly two
  candidate: { first: string; last: string; email: string };  // placeholders until the call gives a name
  today: string;
  offeredStart: string;
}
```

## 3. API

JSON everywhere. Errors: `{ error: string, errors?: FieldError[] }` (`src/shared/builder.ts`). Builder routes take `Authorization: Bearer <builder token>`; 401 without a valid one, 403 `{ error: "Confirm your email first." }` when the step needs a confirmed email.

| Route | Auth | What |
|---|---|---|
| `GET /api/health` | none | `{ status: "ok" }` |
| `POST /api/brand/preview` `{ website }` | none | `Brand` for the domain. Used by step 1 to show what was found before Continue. Never throws for an unknown domain: answers `DEFAULT_BRAND`. Cached per domain in `settings` (`brand:<domain>`) for a day. |
| `POST /api/builders` `StartRequest` | none | Validates (work email, company 2 to 80 characters, a real domain). Creates the builder, saves the brand, sends the one-time link. `201 StartResponse` plus `emailSent`. 400 with `errors` per field. |
| `GET /api/me` | builder | `BuilderView` |
| `POST /api/me/verify/resend` | builder | New one-time token, sent again. Refused (429) within 30 seconds of the last send. |
| `POST /api/verify` `{ token }` | none | Marks the builder confirmed, clears the one-time token. Answers `StartResponse` so the device that opened the link can carry on too. 404 for an unknown or used token. |
| `POST /api/me/questions` `{ description }` | builder, confirmed | Description 20 to 1500 characters. Writes exactly two questions and a job title with Vapi's chat API, saves description, job title and questions. Answers `BuilderView`. |
| `PUT /api/me` `UpdateRequest` | builder, confirmed | Edits question wording (same two ids, 10 to 240 characters each), `agentName` (1 to 8 characters after trimming, letters, digits, spaces, `-` and `'` only), `agentFace` (1 to 10). Answers `BuilderView`. |
| `POST /api/me/build` | builder, confirmed | Needs two questions, a name and a face. Sets `built_at`. Answers `BuilderView`. |
| `POST /api/sessions` `{ today }` | builder, built | Makes a session (section 4). Answers `InterviewSession`. 502 with Onboarded's message when the account cannot be read. |
| `GET /api/sessions/latest` | builder | The builder's newest session, or `404`. |
| `GET /api/sessions/:id` | builder (owner) | `InterviewSession`. Follows the hire's tasks on each read (`followHire`). |
| `POST /api/sessions/:id/approve` | builder (owner) | The offer when the score was under the threshold. 409 while the call is live; one hire only. |
| `GET /api/public/interviews/:token` | link token | `CandidateInterview`. |
| `POST /api/public/interviews/:token/call` `{ today }` | link token | Starts the Vapi web call (`startCandidateCall`). |
| `POST /api/public/interviews/:token/events` | link token | Transcript lines and call start and end only. |
| `POST /api/public/interviews/:token/mcp` | link token | The form app's MCP door (`show_forms` only). |
| `POST /api/mcp/:id` | session secret | The agent's MCP door: every tool. |
| `POST /api/vapi/tool-calls/:id` | session secret header | Vapi's webhook: tool calls, conversation updates, end-of-call report. |
| `PUT /api/admin/public-url` `{ url }` | `ADMIN_TOKEN` | Saves or clears (`null`) `settings.public_url`. |

`BuilderView.step`: `company` is never returned (a builder exists); `email` until confirmed; `questions` until two questions exist; `name` until name and face exist; `built` after that.

## 4. The call

The server side is `src/server/endpoints/sessions.ts`, `src/server/services/interview.ts`, `src/server/services/vapi.ts` and `src/server/services/onboardedMcp.ts`. Their guard rails were found by testing real calls: the conditional-`UPDATE` claims, one hire only, the note-taker, `followHire`, `speakOfProgress`, `taskInHand`, `read_form`'s filters, the MCP doors, the form app's HTML. `CLAUDE.md` explains why each exists.

- **Session creation.** No ATS records. The employee is created in Onboarded directly: `POST /employees` with `first_name: "Guest"`, `last_name: "Candidate"`, a unique `email` of the form `candidate+<session id>@example.com`, no address, and no `employer_id` (the employees endpoint refuses it). `ctx.employeeId` is that employee, `ctx.employerId` and `ctx.jobId` come from env, `ctx.employerName` is the **visitor's company**, never the Onboarded account's employer name. `facts.start_date` is `offeredStartFrom(today)` from the start, so the first `computeCheck` runs with it. No address is sent with the hire.
- **Scored topics** are the session's own: `base.questions.map(q => ({ id: q.id, label: q.topic }))`. The note-taker's hint for a topic is the question's `listenFor`. Question ids are `q1` and `q2`.
- **The note-taker's facts** are `work_location`, `first_name`, `last_name` and the two scores.
- **The agent's prompt** (`buildAva`): its name is `base.agentName`, the employer is `base.company`, the job is `base.jobTitle`. Topics in order: (1) which city, (2) full legal name, (3) question 1, (4) question 2, each asked in the visitor's wording or very close to it, (5) the decision. Speaking rules: short replies, one question per reply, the `bot_say` holding lines, silence while they fill in forms, `[Onboarded]` messages, the pause rule, never asking for a date of birth or Social Security number, and "only an answer given after the whole offer counts". Tools: `get_requirements`, `request_offer`, `start_paperwork`, `read_form`. The first message: "Hi, I'm {name}, the AI interviewer for {company}. This is a short screening for the {jobTitle} job, and if it goes well we can do your new-hire paperwork on this same call. Ready?" The offer names the company, the job title, the site and the start date. Call limits are 3600 s and denoising is on, so the agent can wait while forms are filled. The `customEndpointingRules` regexes must match the wording: the yes/no rule matches "Ready?", "does that work for you", "do you accept"; the 1.5 s rule matches the legal-name question.
- **`offerFor`** needs the site, both scores and (already set) the start date. `start_paperwork`'s READY answer says only the name is already filled in.
- **The journey** has four steps: `screen`, `offer`, `forms`, `ready`. Stage is `ready` once `hire.readyAt` is set. Step details say "2 topics".
- **Views.** `InterviewSession` and `CandidateInterview` in `src/shared/interview.ts` are the contract. `job.employer` and `CandidateInterview.employer` are the visitor's company. `CandidateInterview.questionCount` is 2; `questionNow` is how many of the two topics have a score, plus one while the screening is live, capped at 2 (0 before the call).
- **The API log** records every call to Onboarded as an `ApiCall` entry. The candidate's public view gives out no scores, no requirements and no API log.
- **Local tunnel check.** `callFor` asks cloudflared's status page on port 20248 whether the tunnel is up. `scripts/voice-tunnel.mjs` points the tunnel at the Worker on 8788 and saves the address with `PUT /api/admin/public-url` and `ADMIN_TOKEN` (read from `.dev.vars`).

### Writing the two questions

`POST /api/me/questions` calls Vapi's chat API the way `takeNotes` does (same helper, same key) with a prompt that returns strict lines the server parses, for example:

```
job_title: Banquet server
q1: Tell me about the serving or bartending work you have done.
q1_topic: Experience
q1_listen_for: Real serving or bartending work, where and for how long.
q2: Most of our shifts are evenings and weekends. Does that work for you?
q2_topic: Availability
q2_listen_for: A clear yes to evenings and weekends.
```

Rules for the prompt: exactly two questions; the two things the description cares about most; each one spoken sentence a recruiter would say, under 30 words, in the second person; never ask about age, date of birth, race, religion, national origin, citizenship, disability, health, pregnancy, marital status, children, arrests or salary history, and if the description asks for one of those, ask about the job-related need instead (availability for the shift, ability to do the described work); topics are one or two words. If the model's answer cannot be parsed into two questions, try once more, then answer 502 "The questions could not be written. Try again."

### Brand

`brandFor(domain, env)`:

1. With `BRAND_DEV_API_KEY`: `GET https://api.brand.dev/v1/brand/retrieve?domain=<domain>` with `Authorization: Bearer <key>`. Colours are `brand.colors[].hex`; the logo is the first of `brand.logos[]` preferring `type: "icon"` or a near-square one, else the first.
2. Otherwise, or when that fails: fetch `https://<domain>/` (5 s timeout, 300 KB read at most, HTML only) and read `<meta name="theme-color">`, `<meta name="msapplication-TileColor">`, hex colours that appear in inline `<style>` blocks (the three most frequent, ignoring greys, white and black), and the logo from `<link rel="apple-touch-icon">`, then `rel="icon"`, then `/favicon.ico`.
3. `pickBrandColours` (in `src/shared/builder.ts`) decides primary and secondary. Nothing found: `DEFAULT_BRAND`.

The Worker only ever fetches `https://<domain>/` for a domain that passes `normalizeDomain`, and refuses hosts that are IP addresses, `localhost`, or end in `.local`, `.internal` or `.test`.

## 5. Email

Subject: `Confirm your email to keep building your agent`. Plain text and HTML, both with the link `<public address>/verify?token=<one-time token>` and one line saying the link works once. The visitor's company name is not included, so the form cannot be used to send someone else's words. From `EMAIL_FROM`, display name `SITE_NAME`.

## 6. The app

React 19, react-router, Tailwind v4, lucide-react. No component library. Font: Inter (Google Fonts) with JetBrains Mono for times and API paths.

### Client state

`localStorage`: `bca_token` (builder token), `bca_session` (current session id). `src/app/lib/api.ts`: `apiFetch<T>(path, init)` adds the bearer token, parses `ApiProblem`, throws an `ApiError` carrying `status`, `message` and `errors`.

A guard sends the visitor to the route for `BuilderView.step` when they open a later one, and lets them go back to an earlier one. No token: everything redirects to `/`.

### Routes

| Route | Screen | Reads and writes |
|---|---|---|
| `/` | Step 1 | `POST /api/brand/preview` when the website field loses focus or after 600 ms without typing; `POST /api/builders` on Continue, then `/check-email`. |
| `/check-email` | Step 2 | `GET /api/me` every 2 s until `verified`, then `/questions`. "Send again" calls resend. When `devVerifyUrl` is present, a small grey "Local development" box shows the link. |
| `/verify?token=` | landing | `POST /api/verify`, stores the token, goes to `/questions`. A used or unknown token shows a plain message with a link to `/`. |
| `/questions` | Step 3 | `POST /api/me/questions`, `PUT /api/me` for an edited question. "Say it instead" uses the browser's speech recognition (`SpeechRecognition` or `webkitSpeechRecognition`) to fill the text box; the button is hidden when the browser has neither. |
| `/name` | Step 4 | `PUT /api/me` on change (debounced), `POST /api/me/build` on "Build my agent". |
| `/built` | Step 5 | Nothing to save. |
| `/call` | Call | `GET /api/sessions/latest`, else `POST /api/sessions`. "New call" makes a fresh session. |

### Look: steps 1 to 5

- **Onboarded's branding, not Onboarded's product UI.** Navy `#14193D`, green `#87EA5C`, white, the Onboarded mark. Polished and professional, never playful.
- **Left: the form. Right: a navy panel that shows the agent being built**, with a phone preview in the visitor's colours and a list of the parts. The parts are **boxed cards**: a filled card (`rgba(255,255,255,0.08)`, radius 12) with a green tick for a part that is done; a card with a 1px dashed `rgba(255,255,255,0.28)` border and no fill for a part still to come; a card with a 1px solid `rgba(255,255,255,0.5)` border for the part being worked on now; the "Compliance, by Onboarded" card has a green tint (`rgba(135,234,92,0.12)`) and a green title.
- **Headings are large** (34px, weight 700), body 16px.
- **Numbered steps at the top of the left side** (Company, Email, Questions, Name) and **the buttons at the bottom of the left side**: "Back" on the left as a quiet text button with an arrow, the primary button on the right, navy, 44px tall, radius 8, with an arrow. No green buttons.
- **Step 3 never shows a Vapi configuration** or any other JSON. The right side shows the two questions as cards (number, question, "Scored as <topic>", an edit button that turns the card into a text field with Save and Cancel), then the "Added by Onboarded to every agent" card: where they would work, their legal name, and a start date checked against form deadlines.
- **Step 3 says it is two questions**, before the visitor writes: "Your agent asks two screening questions, then moves to the offer and the forms."
- **Step 5** animates: the agent's face scales in, then the four parts appear one after another about 450 ms apart, then the button. Respect `prefers-reduced-motion` (show everything at once).
- The phone preview on the right updates live: brand colours and logo from step 1, the agent's name and face from step 4.
- No payroll anywhere in the copy.

The ten faces are drawn by one `AgentFace` component (viewBox `0 0 48 48`): `face` (1 to 10), `head` colour, `eye` colour, `size`. Everything that draws the agent uses it.

Validation errors from the server show under their field. Loading states on every button that waits for the server. Every screen works at phone width (the two sides stack, form first).

### Look: the call (`/call`)

- **No bar across the whole page.** A slim bar sits only above the phone, in the left column: the Onboarded mark, "buildacompliantagent.com", and quiet text links "Edit the agent" (to `/questions`) and "New call". The right side starts at the very top of the page.
- **Left column** (about 430px, light grey `#ECEDF1`): the candidate's phone, in the visitor's brand. Ground `brand.primary`, accents `brand.secondary` (the agent's face, the step bars, the sound bars, the Start button), white text, the visitor's logo and company at the top. It is `src/app/components/call/AgentCall.tsx`: start, mute, pause and resume, end, the fixed-height caption over the form, "Expand form", `FormApp` and its sandboxed iframe, the polling. Its four steps are Screen, Offer, Forms, Ready. During the screening the caption label reads "{name} · question n of 2" from `questionNow`.
- **Right side** (Onboarded's branding, `src/app/components/call/WatchView.tsx`): a main column and an API feed.
  - Main column, top to bottom: the journey (four steps); "Steps 1 and 2 · Screen and offer" (black header, fit score, the two topics, the threshold, the offer's state, and "Approve offer" when the score was under it); "Step 3 · Forms" (navy header with the Onboarded wordmark `src/app/public/onboarded-wordmark-on-navy.svg`, the placement requirements table); the transcript.
  - **The forms panel is the big one**: it takes all the height that is left (`flex: 1`), with roomy rows. Once the offer is accepted, "Steps 1 and 2" collapses to one black line (score, the two topic scores, "Offer accepted").
  - **The transcript is a small strip fixed at the bottom** of the main column, about 104px tall, showing the latest lines and scrolling inside itself. It never grows.
  - **The API feed has no panel behind it**: a navy header strip (wordmark, "API", a green "Live" dot), a count line ("14 calls to Onboarded's public API · newest first"), then plain white cards with a 1px border, newest first. A new card slides in; no card stays highlighted.
  - The step-4 note under the table: "Ready for work when every form is done, the employer's part of the I-9 included", with the link to the employer's part when the session has one (`hire.employerUrl`).
- The right side reads only: `status`, `journey`, `criteria`, `score`, `job.threshold`, `transcript`, `api`, `hire`, `callSeconds`, `candidate.first`, `company`, `agentName`, `error`.
- Below 1100px wide the API feed drops under the main column; below 760px the phone comes first and the right side follows.
