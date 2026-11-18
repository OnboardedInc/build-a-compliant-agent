# buildacompliantagent.com

A site by Onboarded where a visitor builds an AI screening agent, then takes a voice call with it as the candidate. On the same call the agent makes an offer, and Onboarded creates the forms the job and the state require. The visitor fills them in on Onboarded's hosted onboarding page while a second panel shows what a recruiter would see: the scores, the forms and every call to Onboarded's public API.

- `SPEC.md` describes the product and its API.
- `CLAUDE.md` is the guide for working in the code: commands, layout, gotchas, limits and guards.

## How it works

| Part | What it does |
|---|---|
| Cloudflare Worker (Hono) | The API and the SPA's static assets, one deploy |
| D1 | Builders, call sessions, settings (`migrations/0001_init.sql`) |
| React 19 SPA (Vite, Tailwind v4) | The four building steps and the call page |
| Vapi | The voice call, plus its chat API for writing the screening questions and taking notes on the call |
| Onboarded public API | Requirements for a work site, the hire, the hosted forms, task progress |
| brand.dev (optional) | Logo and colours for the visitor's company domain |
| Cloudflare Email Sending | The one-time link that confirms the visitor's work email |

## Run it locally

Needs Node, a Vapi account, and an Onboarded account set up as described below.

```bash
npm install
cp .dev.vars.example .dev.vars     # then fill in the values
npm run migrate:local              # creates the local D1 database
npm run dev:voice                  # build, then Worker on 8788, Vite on 5176, and a cloudflared tunnel
```

Open http://localhost:5176.

- **`npm run dev`** runs the Worker and Vite without the tunnel. The building steps work; calls do not, because Vapi's servers cannot reach localhost.
- **The tunnel** (`scripts/voice-tunnel.mjs`) needs `cloudflared` installed. It saves the tunnel's address with `PUT /api/admin/public-url` (using `ADMIN_TOKEN`) and clears it on exit. Its status page is on `127.0.0.1:20248`.
- **Rebuild after UI edits** when testing a call through the tunnel: the tunnel address serves the built SPA from `public/`, not Vite.
- **No mailbox needed locally.** With `DEV_SHOW_VERIFY_LINK=1` the one-time link is shown on the "Confirm your email" page. `wrangler dev` simulates the email send.
- **Type check:** `npx tsc --noEmit`.

## Environment variables

Set in `.dev.vars` locally and as wrangler secrets when deployed. `.dev.vars.example` lists them with placeholders.

| Name | Required | For |
|---|---|---|
| `ONBOARDED_API_KEY` | yes | The Onboarded account every visitor's agent runs against |
| `ONBOARDED_API_BASE` | no | Defaults to `https://app.onboarded.com/api/v1` |
| `ONBOARDED_EMPLOYER_ID` | yes | The employer in that account that placements use |
| `ONBOARDED_JOB_ID` | yes | The job placements use. A job Onboarded does not know is retried without the job. |
| `VAPI_PRIVATE_KEY` | yes | Voice calls, the note-taker, writing the questions |
| `VAPI_ORG_ID` | no | Read from Vapi once and stored in `settings` when missing |
| `BRAND_DEV_API_KEY` | no | Logo and colours from brand.dev. Without it the company's home page is read, which finds less. |
| `ADMIN_TOKEN` | yes | Bearer token for `/api/admin/*` |
| `DEV_SHOW_VERIFY_LINK` | local only | `1` shows the one-time link on the page. Never set it on a deployed Worker. |
| `SHOW_EMPLOYER_LINK` | no | `1` shows the employer's I-9 Section 2 link in the recruiter panel. Off by default, because the link opens the employer side of the shared Onboarded account to every visitor. |

`EMAIL_FROM` and `SITE_NAME` are plain vars in `wrangler.jsonc`. The `EMAIL` binding is Cloudflare Email Sending.

## The Onboarded account

The agent reads everything about work sites and forms from the Onboarded account. The account needs:

- **A placement custom property `start_date`** (date).
- **Work sites as clients**, each with the custom attribute `site_state` (and `site_city`, which is what the agent offers the candidate).
- **Policies keyed on the clients' custom attributes**, which decide the forms a placement needs.
- **Forms with these custom attributes**: `summary` and `applies_when` (what the form is and when it applies), `bring` (what to have ready), `short_name`, and the deadline rules `employee_due_days_from_start`, `employee_due_citation`, `employer_due_business_days_from_start`, `employer_due_citation`. A `source` attribute (`library`, `custom` or `integration`) is optional.
- **The employer and job** named by `ONBOARDED_EMPLOYER_ID` and `ONBOARDED_JOB_ID`.

## Deploy

1. `wrangler d1 create bca-db`, and put the id in `wrangler.jsonc` (it ships with a zero placeholder).
2. `wrangler d1 execute bca-db --remote --file=migrations/0001_init.sql`
3. `wrangler secret put` for each required variable above. Do not set `DEV_SHOW_VERIFY_LINK`.
4. `wrangler email sending enable <your domain>`, so the one-time link can be sent from `EMAIL_FROM`.
5. `npm run deploy`, then add the custom domain to the Worker.

A deployed Worker needs no tunnel: Vapi posts to the Worker's own address.

## Not built yet

- Rate limiting by IP (or Turnstile) on the routes that take no login: `POST /api/brand/preview` and `POST /api/builders`.
- A call limit shorter than one hour.
- Hosted forms in the visitor's brand. They carry the Onboarded account's name and theme.
- Email delivery has not been tested against a real mailbox.
- Visitors type into real Onboarded forms in one shared account. The page asks for made-up details; nothing enforces it.
