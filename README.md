# चौकन्ना (Chaukanna)

> **Consented practice scam calls that train Indian families against digital arrest fraud.**

Chaukanna is an interactive defense simulator designed to protect Indian families from digital arrest fraud and coercion scams. Guardians schedule realistic, culturally nuanced practice scam calls conducted by an AI voice agent (powered by Amazon Nova 2 Sonic). Learners practice recognizing red flags and executing safety tripwires in real time, receiving actionable spoken and visual debriefs immediately afterwards.

**Live:** <https://main.d22ofb6t13cyj2.amplifyapp.com> (AWS Amplify Hosting, `ap-south-1`)

---

**New here? [USER_GUIDE.md](USER_GUIDE.md) walks you from a clean clone to a finished drill, a spoken debrief and a guardian dashboard.**

---

## Prime Directives

1. **Safety code before feature code.** The tripwire, the safe word, the session cap, and the window check exist and are verified before persona customization.
2. **Working beats complete.** Ship each phase end to end before moving to the next.
3. **No secrets in the repo, ever.** Configuration comes from SSM Parameter Store and AWS Secrets Manager at runtime.
4. **Never persist unredacted audio or transcripts.**
5. **No camera access anywhere in the MVP.**

---

## Monorepo Map

```
chaukanna/
  apps/
    web/                 # Next.js 15 App Router UI & route handlers (AWS Amplify)
    agent/               # Python drill voice agent for Bedrock AgentCore Runtime
  services/
    scoring/             # Step Functions task Lambdas (Python)
    video/               # VideoProvider interface (Phase 8 deferred)
  infra/                 # AWS CDK v2 TypeScript infrastructure stack
  fixtures/              # Recorded transcripts and synthetic test utterances
  handoffs/              # What was true at the end of each phase, including what was not verified
  .github/workflows/     # CI/CD deployment pipelines (OIDC)
```

The team's internal planning directory (`docs/`: the PRD, the phase plans, the architecture log
and the AWS runbooks) is deliberately not published. Everything needed to understand, run and
redeploy the system is in this file, in [USER_GUIDE.md](USER_GUIDE.md) and in
[`handoffs/`](handoffs/), which is the honest record of each phase — including what was left
unverified.

---

## Tech Stack

- **Web & API:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, hosted on AWS Amplify.
- **Infrastructure:** AWS CDK v2 (TypeScript) deploying DynamoDB single-table, S3 artifacts bucket, and Cognito User Pool.
- **Voice Agent:** Python 3.12+, Strands Agents SDK `BidiAgent`, Amazon Nova 2 Sonic via Amazon Bedrock AgentCore Runtime (`ap-northeast-1`).
- **Data & Auth:** DynamoDB single-table (`ap-south-1`), S3 encrypted storage, Cognito User Pool for Guardians federated to Google (no passwords anywhere), single-use signed tokens for Learners.
- **CI/CD:** GitHub Actions with AWS IAM OIDC roles.

### The 30 second picture

```
  Guardian (Cognito, Google sign-in)          Learner (signed invite link, no account)
        |                                             |
        +--------------- Next.js 15 on Amplify Hosting (ap-south-1) ---------------+
                         |  SSR compute role, no access keys                       |
                         |                                                         |
        Verified Permissions  ......  every sensitive read: allow or default deny   |
                         |                                                         |
        DynamoDB `chaukanna`  +  S3 `chaukanna-artifacts-*`  (lifecycle + ttl)      |
                         |                                                         |
        EventBridge Scheduler -> ring Lambda -> drill goes `due`                    |
                                                                                   |
                 browser opens a presigned wss:// straight to ----------------------+
                         |
              AgentCore Runtime (ap-northeast-1)   <- Nova 2 Sonic is not in Mumbai
              Strands BidiAgent, tripwire + safe word + 6 min cap on the transport
                         |
              call ends -> transcript to S3, drill -> `ended`
                         |
              Step Functions `chaukanna-scoring` (ap-south-1)
              redact (Bedrock Guardrails) -> judge (Haiku 4.5) -> score -> debrief (Polly) -> finish
                         |
              SCORE row -> learner debrief (quotes) / guardian dashboard (bands only)
```

---

## Quick Start (Local Development)

### 0. Once per clone

```bash
git config core.hooksPath .githooks   # refuses commits that would leak secrets or private files
cp .env.example apps/web/.env.local   # then fill the blanks from infra/cdk-outputs.json
```

`scripts/check-staged.sh` also runs on its own (`scripts/check-staged.sh` for what is staged,
`scripts/check-staged.sh <ref>` for a commit). Real values belong in `.env.local`, never in a
committed template: this repository is public.

### 1. Web Application

```bash
cd apps/web
npm install
npm run dev           # Runs at http://localhost:3000
npm run typecheck     # TypeScript check
npm run lint          # Next.js ESLint
npm run build         # Production build
```

#### Judge demo login

Set `DEMO_MODE=on` in `apps/web/.env.local` and the landing page grows a "Judging this? Try it
now, no sign-in needed" button. It posts to `/api/demo/start`, which mints a throwaway identity,
seeds a household with one consented learner and a wide-open drill window, and drops you on the
dashboard with a **"Demo session — not a real account"** badge and the learner's invite link.

It is an authentication bypass and is off by default. With `DEMO_MODE` unset, `/api/demo/*`
answers 404 and a demo cookie is ignored entirely, so one that escapes a demo deployment is inert
everywhere else. Demo households are identifiable by an `ownerSub` beginning with `demo-`. Never
set it on a deployment a real family uses.

#### Seed the demo data

Before a recording, put a real two-point trend on the dashboard instead of typing rows on camera.
The script writes one household, one consented learner, one `at_risk` drill and one later `safe`
drill, through the same `lib/db/` helpers and the same zod schemas the app uses.

```bash
cd apps/web
AWS_PROFILE=chaukanna npm run seed:demo                              # into the demo household
AWS_PROFILE=chaukanna npm run seed:demo -- --owner-sub=<cognito sub> # into your own household
AWS_PROFILE=chaukanna npm run seed:demo -- --wipe                    # remove only those rows
```

It defaults to `AWS_REGION=ap-south-1` and `TABLE_NAME=chaukanna`; set either to point elsewhere.
Re-running is a no-op — ids are derived, not random — and it prints what the dashboard will show
(`at_risk -> safe`, overall `better`, the weakest tactic and its count) by reading the rows back
through `lib/dashboard.ts`. `--wipe` only ever deletes keys belonging to the household it just
derived; it never scans.

### 2. Infrastructure (CDK)

```bash
cd infra
npm install
npm run build
npm test              # Jest stack assertions
npx cdk synth         # CloudFormation template synthesis
npx cdk diff          # Compare local with deployed stack
```

### 3. Voice Agent

```bash
cd apps/agent
uv sync --all-groups  # the local group adds sounddevice for the terminal drill
uv run pytest         # tripwire, session limits, 10 fixture replays
export AWS_PROFILE=chaukanna VOICE_REGION=ap-northeast-1
uv run python scripts/smoke_sonic.py                 # prove Nova 2 Sonic answers in the region
uv run python -m chaukanna_agent.local --language hi-IN   # talk to the drill, headphones on
uv run python scripts/rehearse.py --script digit_sharer   # typed learner, real model, no mic
```

The same drill also runs as a server for the browser (Phase 3). AgentCore Runtime expects a
WebSocket at `/ws` and a health check at `/ping` on port 8080, in an ARM64 container:

```bash
cd apps/agent
DATA_REGION=ap-south-1 TABLE_NAME=chaukanna ARTIFACTS_BUCKET=<bucket> VOICE_REGION=ap-northeast-1 \
  uv run python -m chaukanna_agent.server        # the same call, driven by a socket
docker build --platform linux/arm64 -t chaukanna-drill .
```

Deploying it is in `handoffs/phase3_agent_handoff.md`. The image URI carries the account id, so it
is passed as `AGENT_IMAGE=...` and never written into `cdk.json`.

Every prompt that ships is in `apps/agent/chaukanna_agent/prompts/` and
`services/scoring/scoring_service/prompts/`, versioned in the filename. They are copied there
verbatim from the team's prompt register by `uv run python scripts/sync_prompts.py`, and a test
fails if the two ever drift.

### CI deploys (GitHub OIDC)

`deploy-infra` and `deploy-agent` assume an IAM role through GitHub OIDC, named by the repository
secret `AWS_ROLE_TO_ASSUME`. Neither workflow carries an AWS access key, and neither fails when
the secret is absent: a preflight job reports the secret missing and the deploy job is skipped.

To enable them, run the setup script yourself against the target account and set the ARN it
prints. It creates a role that can deploy the whole account, so it explains what it will do and
waits for confirmation before creating anything:

```bash
scripts/setup-github-oidc.sh <org>/<repo> --profile chaukanna
gh secret set AWS_ROLE_TO_ASSUME --repo <org>/<repo> --body '<the printed role ARN>'
```

The trust policy is scoped to this one repository (`repo:<org>/<repo>:*`). The script prints the
exact role, policy and trust document it is about to create and waits for confirmation, so there
is nothing to take on trust from this file.

---

## Phase Gates

A gate is passed only when it has been demonstrated on the deployed system. Several phases are
fully built and deployed but wait on a gate that needs a person and a phone; those are marked
honestly rather than ticked.

| Phase | Built | Deployed | Gate passed | What the gate still needs |
|---|---|---|---|---|
| 0 Foundations | yes | yes | yes | — |
| 1 Domain and consent | yes | yes | yes | — |
| 2 The agent, locally | yes | n/a | **no** | A recorded Hindi voice run with the tripwire firing |
| 3 The agent, in the browser | yes | yes | **no** | A real drill from a phone on mobile data |
| 4 Drill lifecycle | yes | yes | **no** | A scheduled drill ringing unattended inside the window |
| 5 Scoring and debrief | yes | yes | **no** | The pipeline has never executed once; see below |
| 6 Authorization, safety, dashboard | yes | yes | yes | — |
| 7 Demo and submission | in progress | — | **no** | Video, writeup, blog, submission |

**Phase 6 is verified against the deployed policy store**, not only in tests: all six Cedar
statements, all four actions, eleven allow/deny cases including a guardian denied a transcript
with sharing off and permitted with it on, and a paused learner refused a new drill by the
`forbid` rather than by a branch.

**Phase 5 is the one to watch before recording.** Every piece is deployed and healthy — the
Bedrock guardrail is `READY`, all five Lambdas exist, the `chaukanna-scoring` state machine is
live — but it has **zero executions**. The demo seed writes its score rows directly, so a
dashboard trend proves nothing about the pipeline. Run one execution end to end before you rely
on a debrief, or on a Step Functions graph, on camera.

---

## Demo access

There are no passwords in this product, and there are none in this file.

- **Guardian.** Sign in at the live URL with Google through Cognito managed login. Any Google
  account works; the household id is derived from the Cognito subject, so a first sign-in creates
  an empty household of your own.
- **Judge demo login.** With `DEMO_MODE=on` set as an Amplify environment variable on the branch,
  the landing page grows a "Judging this? Try it now, no sign-in needed" button that mints a
  throwaway identity. It is off unless that variable is set, and `/api/demo/*` answers 404 when it
  is not. Set it in the Amplify console, never in the repository.
- **Learner.** A learner never has an account, a password or an email address. The guardian's
  dashboard prints a single-use invite link (and a QR code for it); that link *is* the credential,
  it expires, and it is revoked on logout.
- **AWS.** Everything server-side uses the Amplify SSR compute role or a GitHub OIDC role. There
  are no AWS access keys anywhere in this repository or in its history. Runtime secrets — today
  only the invite signing key — live in Secrets Manager under `chaukanna/invite-signing-key` and
  are read at request time. Non-secret configuration comes from Amplify environment variables and
  CDK outputs; `.env.example` lists the names and none of the values.

---

## Credits

No sample, template or scaffold has been copied into this repository. Where a published example
or document informed an implementation, it is listed here with its licence.

| Source | Licence | How it is used |
|---|---|---|
| [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app) scaffold | MIT | `apps/web` was initialised with it; the generated files have since been rewritten. |
| [AWS CDK v2](https://github.com/aws/aws-cdk) project scaffold (`cdk init app --language typescript`) | Apache-2.0 | `infra/` layout only. |
| [`bedrock-agentcore` Python SDK](https://github.com/aws/bedrock-agentcore-sdk-python) | Apache-2.0 | A dependency of `apps/agent`. No sample code copied. |
| [Strands Agents SDK](https://github.com/strands-agents/sdk-python) | Apache-2.0 | `BidiAgent` is used as a dependency; the drill loop, tripwire and transport are ours. |
| [AgentCore Runtime WebSocket contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html) (port 8080, `/ws`, `/ping`) | AWS documentation | Implemented from the published contract, not from sample code. |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) and [botocore](https://github.com/boto/botocore) | Apache-2.0 | Dependencies. The SigV4 presigner for `wss://` in `apps/web/src/lib/agentcore.ts` was written by hand and pinned byte for byte against output from botocore's own signer. |
| Tailwind CSS, React, zod, vitest, jest, ruff, uv | MIT / Apache-2.0 / BSD | Dependencies, unmodified. |

Every other library is used as a dependency under its own licence. This project is Apache-2.0.

---

## AI Coding Tools & Hackathon Compliance

In compliance with hackathon regulations, the following AI coding assistants were used to build
this repository:

- **Claude Code** (Anthropic) — Phases 1 through 7: web app, voice agent, scoring pipeline,
  infrastructure, authorization and documentation.
- **Google Antigravity AI** — early scaffolding and exploratory work.

Contribution rules the team held itself to are in [CONTRIBUTING.md](CONTRIBUTING.md): every commit
inside the event window from that member's own account, no code carried over from anyone's earlier
projects, and a pre-commit hook (`scripts/check-staged.sh`, wired through `git config
core.hooksPath .githooks`) that refuses a commit containing environment files, key material or a
template filled with real ids.

No third party samples or templates are copied into this repository. Libraries are used as
dependencies under their own licences; see **Credits** above.

---

## License

This project is licensed under the Apache 2.0 License. See [LICENSE](LICENSE) for details.
