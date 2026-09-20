# Chaukanna — User Guide

**चौकन्ना (Chaukanna)** runs *consented* practice scam calls so that elderly members of an Indian
family can rehearse hanging up on a "digital arrest" fraud call before a real one ever reaches
them. This guide takes you from a clean machine to a finished drill, a spoken debrief and a
guardian dashboard.

There are two people in the product, and the guide is written for both:

| Role | Who they are | What they need |
|---|---|---|
| **Guardian** | The adult child. Signs in with Google. | Invite a parent, see how they did. |
| **Learner** | The parent or grandparent, Hindi first. | A link. No account, no password, no app. |

---

## 0. Where to try it

| What | Where | Status |
|---|---|---|
| Web app (guardian + learner) | *(paste the Amplify URL here once the app is connected)* | Runs locally today; see §2 |
| Voice drill agent | Amazon Bedrock AgentCore Runtime, `ap-northeast-1`, runtime `chaukanna_drill` | Deployed |
| Data, auth, scheduling, scoring | `ChaukannaStack`, `ap-south-1` | Deployed |
| Voice stack (ECR + AgentCore) | `ChaukannaVoiceStack`, `ap-northeast-1` | Deployed |

The AWS backend is live in the project account. The web front end is what you run in §2, and the
same build is what goes to Amplify Hosting.

> **You cannot use someone else's account.** Chaukanna talks to a DynamoDB table, a Cognito pool,
> an S3 bucket, a Step Functions state machine and an AgentCore runtime that belong to whoever
> deployed it. To run it end to end you need either the deployed URL above or your own deploy
> (§6).

---

## 1. What actually happens, end to end

```
Guardian signs in with Google  →  creates a household  →  invites a learner
        ↓
Learner opens the signed link on their phone  →  hears what practice calls are
        →  says "हाँ" out loud (recorded to S3)  →  picks the hours they may be called
        ↓
A one-time EventBridge schedule fires at a random moment inside that window
        ↓
Learner's page shows a ring screen  →  they tap answer, grant the microphone once
        ↓
Live Hindi / Indian-English voice drill against Amazon Nova 2 Sonic, six-minute hard cap,
stages S0 hook → S1 handoff → S2 fear → S3 isolation → S4 identifier → S5 money
        ↓
Call ends (hang up, safe word, tripwire, distress, or the cap)
        ↓
Step Functions: redact (Bedrock Guardrails) → judge (Claude Haiku 4.5) → score (pure Python)
        → debrief text → Amazon Polly mp3 → score row
        ↓
Learner hears a spoken debrief naming the exact sentence that was the moment to hang up.
Guardian sees a band (Safe / Wobbly / At risk) and the trend — never the transcript,
unless the learner grants sharing.
```

---

## 2. Run it on your own machine

### Prerequisites

- Node.js 20+
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) (only if you want to run the agent locally)
- An AWS profile with access to the deployed stacks (`AWS_PROFILE=chaukanna` in the examples)
- Chrome, Edge or Safari. **Headphones** if you are going to speak to the drill.

### 2.1 Configure

```bash
git clone https://github.com/ishaangupta-YB/chaukanna.git
cd chaukanna
git config core.hooksPath .githooks      # refuses commits that would leak secrets
cp .env.example apps/web/.env.local
```

Fill `apps/web/.env.local` from `infra/cdk-outputs.json` (written by `cdk deploy --outputs-file`)
or from the CloudFormation console. The values the web app needs:

```
AWS_REGION=ap-south-1
VOICE_REGION=ap-northeast-1
TABLE_NAME=chaukanna
ARTIFACTS_BUCKET=chaukanna-artifacts-<account id>
USER_POOL_ID=...
USER_POOL_CLIENT_ID=...
COGNITO_DOMAIN=...
AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:ap-northeast-1:<account id>:runtime/chaukanna_drill-...
RING_LAMBDA_ARN=...
SCHEDULER_INVOKE_ROLE_ARN=...
APP_URL=http://localhost:3000
DEMO_MODE=on
```

No secrets go in this file. The invite-signing HMAC key lives in Secrets Manager and is read at
runtime.

### 2.2 Start

```bash
cd apps/web
npm install
npm run dev          # http://localhost:3000
```

Check it is wired to AWS:

```bash
curl -s http://localhost:3000/api/health     # { ok: true, region, table }
```

---

## 3. The 90-second path: judge demo mode

`DEMO_MODE=on` puts a **"Judging this? Try it now, no sign-in needed"** button on the landing
page. One click and you are inside a working guardian dashboard.

1. Open `/` and press **Open the judge demo**.
2. You land on the dashboard wearing a **"Demo session — not a real account"** badge. It has
   already created:
   - a household, `Demo household (judge preview)`
   - one learner, `Maa (demo)`, already consented, language Hindi
   - a drill window that is open every day, 00:00–23:59 IST, so **Ring now** works immediately
   - the learner's invite link, shown on the dashboard with a QR code
3. Open that invite link on your phone (scan the QR) — that is the learner side.
4. Back on the dashboard, press **Ring now** on the learner's card.
5. The phone shows the ring screen. Tap **answer**, allow the microphone once, and the drill
   starts speaking Hindi within a few seconds.
6. End it however you like (§4), then open the debrief on the phone and reload the dashboard.

**What demo mode is:** a deliberate authentication bypass, gated on the env var being exactly
`on`. Every click mints a fresh throwaway identity (`ownerSub` starts with `demo-`), the cookie
lasts two hours, and with the flag off `/api/demo/*` returns 404 and the cookie is never even
read. Never set it on a deployment a real family uses.

---

## 4. The real path, step by step

### 4.1 Guardian: sign in and invite

1. Open `/` and press **Continue with Google**. Cognito managed login handles it; there is no
   password path on the user pool at all.
2. Create a household (name it after the family).
3. **Invite a family member** → enter their display name and language (Hindi or Indian English).
4. You get a **single-use invite link, valid 72 hours**, with a QR code. Send it to them however
   you already talk to them, or hold the phone up to the QR.

### 4.2 Learner: consent (this is the only gate that matters)

On their own phone, the learner opens the link and sees one screen, in their language, in large
type:

1. What a practice call is, who set it up, and that it is not real.
2. A single primary button. They **say "हाँ" out loud**; the browser records it, uploads it to S3
   with a presigned PUT, and the consent row stores the timestamp, the language, the audio key and
   the categories.
   *If the microphone prompt is never answered, after 12 seconds the screen falls back to typing
   "हाँ", and the consent row records which method was used.*
3. They pick their **drill window** — which days, and between which hours they may be called.
   The default is weekdays 11:00–18:00 IST.

From that moment, every learner screen carries a **stop-all button** in the footer.

### 4.3 The call

A drill reaches the learner one of two ways:

- **Scheduled** (the real behaviour): the guardian presses *Schedule a practice call*. A one-time
  EventBridge schedule is created at a **random instant inside the learner's window**. When it
  fires, a Lambda re-checks consent, status and window *at that moment* and flips the drill to
  `due`. The learner's open page polls and shows the ring screen. Expect roughly a ten-second lag:
  EventBridge Scheduler promises "within a minute", not to the second.
- **Ring now** (for demos): guardian-only, rate limited to once per ten minutes, and it still
  respects consent and the window.

On the ring screen the learner taps answer and grants the microphone **once**. Audio streams both
ways over a WebSocket to AgentCore. The screen says *practice* the whole way through, shows a
countdown, shows the safe word, and has no field, link, upload or keypad anywhere — a drill has no
data-collection surface by design.

**Four ways out, all of them work mid-sentence:**

| Way out | What happens |
|---|---|
| **Hang up** | Ends the call and records a pass on the disconnect criterion. |
| **Say the safe word** (default `ROKO`, shown on screen) | The caller breaks character within one turn and reads the reassurance script. |
| **Say any 6+ digit number** | The **tripwire** fires on the transport, not in the prompt. The span is dropped before anything is persisted, and the drill stops. |
| **Sound frightened, unwell, or ask "is this real?"** | The drill ends immediately. |

And three limits the model cannot talk its way past, because they are enforced in code:

- **six-minute hard cap** (`SESSION_MAX_SECONDS=360`), with a reconnect before Nova's own session
  limit so a long call does not simply die
- **one drill per learner per seven days**, checked when a drill is created *and again* when the
  session starts
- **the window**, checked at creation and re-checked at the instant the schedule fires

### 4.4 The debrief

The call screen leads straight to the debrief, which polls while the pipeline runs (target: under
60 seconds).

The learner gets, in their own language, under 120 words, spoken aloud by Amazon Polly:
- the exact caller sentence that was the moment to hang up, quoted
- what they did well
- and always the same three rules: **hang up, call 1930, never move money to verify it**

If the judge model fails twice, the drill is marked `score_failed` and the learner gets the
generic debrief. **A guessed score is never shown.**

### 4.5 The guardian dashboard

Per learner: status, language, drill window, the next scheduled call, and a history of bands —
**Safe (70–100) / Wobbly (40–69) / At risk (0–39)** — with honest words for the states that are not
scores (`Ringing now`, `Result on the way`, `Not answered`, `Cancelled`, `No result this time`).

What the guardian **cannot** see is what their parent actually said. The dashboard reads bands
only; the score row's pointer to the redacted transcript is stripped before it can reach a page.

### 4.6 Stopping everything

The learner's **stop-all** button sets their status to paused, cancels pending schedules and marks
pending drills cancelled. **Withdraw consent** goes further and revokes. Both are one tap, from any
screen, and cancelled drills do not count against the weekly cap.

---

## 5. Talking to the drill without the web app

Useful for testing the persona, the tripwire and the safety rails on their own.

```bash
cd apps/agent
uv sync --all-groups
uv run pytest                                            # tripwire, caps, 10 fixture replays

export AWS_PROFILE=chaukanna VOICE_REGION=ap-northeast-1
uv run python scripts/smoke_sonic.py                     # prove Nova 2 Sonic answers in-region
uv run python -m chaukanna_agent.local --language hi-IN  # talk to it, headphones on
uv run python scripts/rehearse.py --script digit_sharer  # typed learner, real model, no mic
```

Score a recorded transcript through the deployed pipeline:

```bash
cd services/scoring
AWS_PROFILE=chaukanna uv run python -m scoring_service.cli \
  --transcript ../../fixtures/transcripts/compliant.json --no-dry-run
```

Ten fixtures covering every band live in `fixtures/transcripts/`, and their recorded judge outputs
in `fixtures/judge/` are replayed offline by the test suite.

---

## 6. Deploying your own

Every command you need is below; the per-phase deployment notes, including the hazards, are in
[`handoffs/`](handoffs/). The short version:

```bash
# 1. Infrastructure first: table, bucket, user pool, secret, scheduler role, ring Lambda,
#    guardrail, scoring Lambdas, state machine.
cd infra && npm install && npm run build
AWS_PROFILE=chaukanna npx cdk deploy ChaukannaStack --outputs-file cdk-outputs.json

# 2. The voice stack. AGENT_IMAGE is NOT optional: a deploy without it removes the live runtime.
export AGENT_IMAGE=<account>.dkr.ecr.ap-northeast-1.amazonaws.com/chaukanna-drill:<tag>
AWS_PROFILE=chaukanna npx cdk deploy ChaukannaVoiceStack
```

Two prerequisites are outside CloudFormation and fail at *runtime* rather than at deploy if they
are missing:

1. **Bedrock model access**, granted per region in the console: Nova 2 Sonic in `ap-northeast-1`,
   Claude Haiku 4.5 in `ap-south-1`.
2. The judge must be called by its **inference profile id**
   (`global.anthropic.claude-haiku-4-5-20251001-v1:0`), not the bare model id.

Then connect the web app in the Amplify console (`ap-south-1`): deploy from GitHub, app root
`apps/web`, platform `WEB_COMPUTE`, **attach the compute role `chaukanna-amplify-compute-role`**
(without it every AWS call from a route handler is AccessDenied at runtime with a perfectly green
build), and paste the CDK outputs as environment variables.

---

## 7. Troubleshooting

| What you see | Why, and what to do |
|---|---|
| `/api/health` returns an error | `.env.local` is missing a value, or your AWS profile cannot reach `ap-south-1`. |
| Sign in bounces back to the landing page with "Sign in did not complete" | The Cognito callback URL does not include your origin. Add `http://localhost:3000/api/auth/callback` to the app client. |
| The judge demo button is not on the page | `DEMO_MODE` is not exactly `on`. Restart `npm run dev` after changing it. |
| The invite link says it is used up | Invites are **single use** and expire in 72 hours. Issue a new one from the dashboard. |
| "Practice calls are paused" on the call screen | The learner pressed stop-all or withdrew consent. Resume from the learner's home screen. |
| "You have already practised this week" | The one-per-seven-days cap. Cancelled and missed drills do not count; completed ones do. |
| The ring never arrives | The schedule fires at a random time inside the window, and EventBridge is accurate to about a minute. Use **Ring now** for a demo. |
| No caller audio after answering | Microphone permission was denied — the drill is marked *cancelled*, not spent, so you can try again. Check the browser is not muted and you are on `https://` or `localhost`. |
| The debrief screen keeps waiting | The Step Functions execution is still running or failed. Check `chaukanna-scoring` in `ap-south-1`; a failed judge shows the generic debrief rather than a guessed number. |
| No debrief audio, but a band is shown | Polly failed. That is deliberate: a correct score is never thrown away because text-to-speech broke. |

---

## 8. Safety properties you can verify yourself

1. **Nothing without consent.** No drill can be created for a member who has not consented in
   their own voice, and revoking cancels every pending schedule.
2. **The tripwire is transport-level.** It matches digit runs in Latin numerals, Devanagari
   numerals and number words in English, romanized Hindi and Devanagari, and carries a run across
   recognition fragments. A prompt is not a control.
3. **No collection surface.** The drill can only listen and talk — no input, no link, no upload,
   no keypad, ever.
4. **No real agencies, officers, case numbers or emblems.** Generic words like "cyber cell" are
   allowed; invented badge numbers and documents are not.
5. **No camera anywhere.** A `Permissions-Policy` header denies it on every response.
6. **Only the caller's audio is recorded.** The learner's microphone stream is the one place a
   real Aadhaar number could survive, and nothing in the product needs it.
7. **Retention.** Consent and drill audio expire from S3 by lifecycle rule at 7 days; transcripts
   are redacted through Bedrock Guardrails before the first durable write.

---

## 9. Where to read more

| Document | What is in it |
|---|---|
| [`README.md`](README.md) | The stack, the architecture picture, how to run each package, credits |
| [`handoffs/`](handoffs/) | What was true at the end of each phase, including what was *not* verified |
| [`LEARNINGS.md`](LEARNINGS.md) | What broke, and what it taught |
| [`apps/agent/chaukanna_agent/prompts/`](apps/agent/chaukanna_agent/prompts/) | Every drill prompt that ships, versioned in the filename |
| [`services/scoring/scoring_service/prompts/`](services/scoring/scoring_service/prompts/) | The judge and debrief prompts |
| [`infra/lib/chaukanna-stack.ts`](infra/lib/chaukanna-stack.ts) | Every AWS resource, the Cedar schema and all six policies |
| [`fixtures/`](fixtures/) | The transcripts and recorded judge outputs the suites replay |

The team's internal planning directory (`docs/`) is not published.
