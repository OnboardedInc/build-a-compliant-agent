# CLAUDE.md

Guidance for working in this repository. `SPEC.md` describes the product and its API; this file is what to know before changing the code.

## Commands

```bash
npm run dev:voice      # build, then Worker (8788) + Vite (5176) + cloudflared tunnel. Needed for calls.
npm run dev            # Worker + Vite only. The building steps work; calls do not.
npm run migrate:local  # apply migrations/*.sql to the local D1 database
npm run build          # SPA to public/ (the tunnel address serves this build: rebuild after UI edits)
npm run deploy         # build + wrangler deploy
npx tsc --noEmit       # type check
```

Ports: Worker 8788, Vite 5176 (`/api` is proxied to the Worker), cloudflared's status page 20248. They are set apart from the common defaults so this project can run beside another Worker project on the same machine.

## Shape

```
src/shared/builder.ts     the contract for the building steps: Brand, questions, BuilderView, work-email and colour helpers
src/shared/interview.ts   the session contract: InterviewSession (watch view), CandidateInterview (phone)
src/server/endpoints/     builders.ts (steps 1 to 5), sessions.ts (the call, the webhook, the MCP doors)
src/server/services/      vapi.ts (the agent's prompt, tools, note-taker), interview.ts (Onboarded: checks, hire, tasks),
                          onboardedMcp.ts (the form app), brand.ts, questions.ts, email.ts, onboarded.ts, security.ts
src/app/pages/            Company, CheckEmail, Verify, Questions, Name, Built, Call
src/app/components/build/ the two-sided building layout and the agent panel
src/app/components/call/  AgentCall (the phone), FormApp (MCP host for Onboarded's hosted page), WatchView, useVoiceCall
scripts/voice-tunnel.mjs  the local tunnel for Vapi's webhooks
tests/                    browser and spoken-call tests against a running dev server
```

One Worker serves the API and the SPA. All configuration is env (`.dev.vars`, wrangler secrets); nothing a visitor enters is a credential. `src/server/index.ts` declares the env on the Hono `Bindings` type.

## How the call works

The agent's design came from testing real calls. Keep these when changing the prompt, tools or follow logic:

- **The agent only talks.** What the candidate said (work site, name) and how each answer scores are read from the transcript by a note-taker, a second model that never speaks (`takeNotes` in `vapi.ts`). When the agent had save and score tools, the model often wrote its reply beside the tool call and again after the result, and the candidate heard the question twice. Do not move bookkeeping back into the agent's tools.
- **Holding lines.** Tools that make the candidate wait speak a short line through `bot_say` (Vapi's reserved tool argument) with an empty `request-start` message, so Vapi adds no filler. `request_offer` is the exception: its line is the tool's `request-start` message, because the model otherwise said it twice.
- **Turn-taking is keyed on the agent's words.** `customEndpointingRules` give a yes/no question a short wait and the legal-name question 1.5 s; everything else uses smart endpointing. If the wording of a question changes, check the rule regexes still match ("Ready?", "does that work for you", "do you accept", the legal-name question).
- **One hire only.** The hire is claimed with a conditional `UPDATE` before any call to Onboarded, so a double request cannot create two hires. `speakOfProgress` claims each spoken update the same way, because both pages poll.
- **Which form is on screen.** The hosted link is made with `task_ids` so the forms come in the order of the requirements table. Among unfinished forms, the one whose `updated_at` moved last is the one on screen (`taskInHand`). Onboarded's page tells a parent page nothing, so this is inferred.
- **The form app's iframe needs `allow-same-origin` and `allow-forms`.** The hosted page is nested inside the MCP App frame and inherits its sandbox flags; without them it cannot keep its session or submit. Keep the app's HTML a constant of the Worker.
- **Progress comes from polling tasks**, not webhooks.

## How it differs from a full ATS integration

- **No accounts, no ATS records.** A visitor is a `builders` row. Their browser holds its `token`; the one-time email link only confirms the address. Nothing past step 2 works until `verified_at` is set.
- **The agent is data.** Name, face, company, brand, job title and the two questions are copied into the session's `base` when it is made. A later edit does not change a session.
- **Two screening questions, written by a model** (`services/questions.ts`, Vapi's chat API) from the visitor's description. The prompt keeps questions off protected topics.
- **A short call.** City, legal name, question 1, question 2, offer. No email question, no start-date question, no `check_start_date` tool: the start date is fixed when the session is made.
- **It ends at Ready.** There is no payroll step.
- **One Onboarded account for everyone.** The employee is created per session as "Guest Candidate" with a `candidate+<session>@example.com` address, and renamed at the hire with the name from the call. The placeholder name is never shown or spoken (`UNNAMED` in `sessions.ts`).

## Design decisions

- Work email only; company name and website; brand pulled by domain. **The darker colour is always the primary, the lighter the secondary** (`pickBrandColours`).
- **Two screening questions at most**, and the page says so before the visitor writes.
- Agent name at most 8 characters; ten faces.
- **Onboarded's branding, not Onboarded's product UI**, for the building steps: large headings, a navy panel on the right with a phone preview and the parts as boxed cards, numbered steps at the top, Back and Continue at the bottom. Polished, never playful. **Never show a Vapi configuration.**
- On the call screen there is **no bar across the page**: a slim bar sits above the phone only, and the right side starts at the top.
- Behind the call: **the forms panel is the big one**, the transcript is a small fixed strip at the bottom, the API feed has no panel behind it.
- No payroll anywhere.

## Limits and guards

Each of these stops a stranger on the public site from spending the shared Vapi and Onboarded accounts or reaching another visitor's data. Keep them when changing the routes.

- **One call start per session.** `startCandidateCall` claims `$.claimedAt` with a conditional `UPDATE` before it asks Vapi for a call. A second start gets 409. The claim is released if Vapi fails and can be taken again after 90 s.
- **12 sessions per builder per day** (`MAX_SESSIONS_PER_DAY`) and **3 one-time links per email address per 24 h** (`MAX_STARTS_PER_EMAIL`, 429 after that).
- **Approve is only for a call that ended without a hire.** It needs a status other than idle and `offer.state` of `review` or `offered`; anything else gets 409.
- **The start date is the server's.** `today` from the browser is clamped to the server's day, plus or minus one.
- **The email carries no visitor text.** The company name is not in the subject or the body, so the form cannot be used to send someone else's words from the site's domain. Email addresses are at most 254 characters.
- **The employer's I-9 Section 2 link is off by default.** The server sends `employerUrl` to the browser only when `SHOW_EMPLOYER_LINK` is `1` (`employerLinkOn` in `sessions.ts`); otherwise every visitor would get a link into the shared account's employer side.
- **`devVerifyUrl` is only given to a request made to localhost.** With `DEV_SHOW_VERIFY_LINK=1` a request through the tunnel still does not get the link.
- **Edited questions are checked.** `PROTECTED` in `builders.ts` refuses a question about age, family, health, religion, citizenship, criminal history or pay history (400), because an edited question skips the model that writes them.
- **The brand fallback fetches only the company's own domain**: the home page, at most three same-domain https redirects, and stylesheets on that domain. Private and local hosts are refused (`publicHost`).
- **A session belongs to its builder.** Every `/api/sessions/:id` route checks `builder_id`; another builder's session reads as 404. An idle session older than a day is not offered again.
- **Admin routes fail closed.** `/api/admin/*` compares the bearer token with `ADMIN_TOKEN` in constant time and refuses every request when `ADMIN_TOKEN` is unset.
- **Vapi's `tool-calls` client message is off**, so tool arguments and results are not sent to the browser. The page only needs `tool-calls-result` to know a tool finished.
- **The candidate's public routes give out no scores, requirements or API log.** Answers and scores come only from the conversation Vapi's servers post to the webhook, never from the candidate's browser.
- Transcript line ids and tool arguments are cut to a fixed length before they are stored.
- Every JSON response under `/api` has the configured secrets and the caller's tokens redacted before it is sent (`src/server/index.ts`).

## Testing

The tests in `tests/` drive a real browser against a running `npm run dev:voice` and write screenshots, synthesized audio and saved calls to `tests/out/` (not committed).

- **The browser walk** goes through the building steps and saves screenshots at 1440 and 390 px.
- **The spoken call** builds an agent through the API, takes a whole call with a synthesized voice played through a fake microphone, fills every form in Onboarded's hosted page, and checks the result against Vapi's own log. Run it after any change to the prompt, the tools or the follow logic.
- **Do not edit files while a spoken call runs.** A Worker or Vite reload ends the call.
- Browser tests must launch Chromium with the fake-microphone flags from `tests/lib/fake-mic.mjs`; without them Chromium opens the real microphone.
