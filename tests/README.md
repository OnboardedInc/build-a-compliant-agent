# Tests

Two end-to-end tests that drive the app in a real browser, and unit tests of the sign-in wall (`npm run test:unit`, no server needed).

## Before you run them

1. Fill in `.dev.vars` (copy `.dev.vars.example`). Set `DEV_SHOW_VERIFY_LINK=1`: the tests read the one-time email link from the page instead of from an inbox.
2. Start the app with `npm run dev:voice` and leave it running. It builds the site, then runs the Worker (port 8788), Vite (port 5176) and a cloudflared tunnel. The browser walk also works with `npm run dev`. The call test needs the tunnel, because the voice provider posts to the Worker during the call.
3. Install the browser once if Playwright asks for it: `npx playwright install chromium`.

## `npm run test:ui`

Walks the building steps the way a visitor would: company and work email (a personal address is refused), the one-time link, the two screening questions (one is edited), the agent's name and face, the built screen and the call screen. It does not start a call. It checks each screen at 1440 px and 390 px wide and saves screenshots to `tests/out/ui/`. It takes about a minute.

## `npm run test:call`

Builds an agent through the API, then takes one whole spoken call on the call page with no person on it:

- The candidate's voice is made with macOS `say` and `afconvert`, so this test runs on a Mac only.
- The browser gets a fake microphone (`tests/lib/fake-mic.mjs`). It never opens your real microphone.
- It answers the screening, pauses and resumes, accepts the offer, asks the agent two questions about the forms, and fills every form in Onboarded's hosted page (`tests/lib/forms.mjs`).
- At the end it reads the call back from the voice provider with `VAPI_PRIVATE_KEY` from `.dev.vars`, and checks for questions heard twice and for dead air.

It prints PASS or FAIL for each check and exits with 1 if any check failed.

**Read this before you run it:**

- **It places a real voice call that is billed** to the voice provider account in `.dev.vars`. A run takes about five minutes.
- **It creates a test employee and a placement** in the Onboarded account in `.dev.vars`, and completes their forms.
- **Every personal detail it uses is made up**: the candidate "Maya Torres", the SSN, the date of birth, the license and passport numbers, and `tests/assets/sample-passport.png`, which is marked "Sample, not a real document". The work email uses the reserved domain `larkspur-staffing.example`, so no mail reaches a real inbox.
- **Do not edit anything in `src/` while it runs.** A Worker or Vite reload ends the call, and the run fails.

## Settings

Each test reads these environment variables. All are optional.

| Variable | Default | What it is |
| --- | --- | --- |
| `BASE_URL` | unset | A deployed site's address. Sets both `APP` and `API`. When the site's sign-in wall is on, the tests sign a session cookie with `SESSION_SECRET` from the git-ignored `.prod.vars` and skip the email-link steps. |
| `TEST_ACCESS_EMAIL` | `qa@onboarded.com` | The signed-in address the cookie carries, and the builder's email, when the wall is on |
| `APP` | `http://localhost:5176` | The app's address |
| `API` | `http://localhost:8788` | The Worker's address (call test only) |
| `WEBSITE` | `cloudflare.com` | The company website the brand is read from |
| `TEST_EMAIL_DOMAIN` | `larkspur-staffing.example` | The domain of the made-up work email |
| `LABEL` | `call` | Prefix for the call test's screenshots and saved call |
| `VERBOSE` | unset | Set to `1` to log every form field the call test fills |

## What the tests write

Everything goes under `tests/out/`, which is not committed:

- `tests/out/ui/` and `tests/out/call/`: screenshots
- `tests/out/audio/`: the synthesized candidate lines and the silent file the fake microphone plays
- `tests/out/calls/`: the call as the voice provider logged it, with the whole transcript
