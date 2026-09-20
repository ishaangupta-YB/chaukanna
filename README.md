# चौकन्ना (Chaukanna)

> **Consented practice scam calls that train Indian families against digital arrest fraud.**

Chaukanna is an interactive defense simulator designed to protect Indian families from digital arrest fraud and coercion scams. Guardians schedule realistic, culturally nuanced practice scam calls conducted by an AI voice agent (powered by Amazon Nova 2 Sonic). Learners practice recognizing red flags and executing safety tripwires in real time, receiving actionable spoken and visual debriefs immediately afterwards.

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
  docs/                  # Architecture, PRD, phases, prompts, guides
    phases/              # Phase-specific execution plans and gates
  fixtures/              # Recorded transcripts and synthetic test utterances
  .github/workflows/     # CI/CD deployment pipelines (OIDC)
```

---

## Tech Stack

- **Web & API:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, hosted on AWS Amplify.
- **Infrastructure:** AWS CDK v2 (TypeScript) deploying DynamoDB single-table, S3 artifacts bucket, and Cognito User Pool.
- **Voice Agent:** Python 3.12+, Strands Agents SDK `BidiAgent`, Amazon Nova 2 Sonic via Amazon Bedrock AgentCore Runtime (`ap-northeast-1`).
- **Data & Auth:** DynamoDB single-table (`ap-south-1`), S3 encrypted storage, Cognito User Pool for Guardians, single-use signed tokens for Learners.
- **CI/CD:** GitHub Actions with AWS IAM OIDC roles.

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

Prompts live in `docs/AGENT_PROMPTS.md` and are copied verbatim into
`apps/agent/chaukanna_agent/prompts/` by `uv run python scripts/sync_prompts.py`. A test fails if they drift.

---

## Phase Gates

- [x] **Phase 0: Foundations** — Monorepo scaffolded, CDK stack synthesized, Next.js app with `/api/health`, CI/CD workflows ready.
- [ ] **Phase 1: Domain and Consent** — Guardian invite flow & learner consent. Built and verified locally against the deployed stack; gate waits on the Amplify deploy.
- [ ] **Phase 2: The Agent, Locally** — Hindi drill runs end-to-end in terminal with tripwire. Built, fixture suite green, real model rehearsed; gate waits on a recorded voice run. The spoken break character line is deliberately deferred: the drill still ends on time, silently.
- [ ] **Phase 3: The Agent, in the Browser** — Drill runs from phone browser against AgentCore.
- [ ] **Phase 4: Drill Lifecycle** — Scheduled drill rings inside the window.
- [ ] **Phase 5: Scoring and Debrief** — Finished drill produces a band and spoken debrief.
- [ ] **Phase 6: Authorization, Safety, Dashboard** — Cedar policy denial, kill switch, trend dashboard.
- [ ] **Phase 7: Demo and Submission** — Final walkthrough, video, documentation.

---

## AI Coding Tools & Hackathon Compliance

In compliance with hackathon regulations, the following AI coding assistants were used to build this repository:
- **Google Antigravity AI**
- **Claude Code** (Anthropic), Phases 1, 2 and 3

No third party samples or templates are copied into this repository. Libraries are used as
dependencies under their own licences. The AgentCore Runtime WebSocket contract (port 8080, `/ws`,
`/ping`) is implemented against the published
[AWS documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)
using the Apache 2.0 licensed `bedrock-agentcore` SDK as a dependency; no sample code is copied.

---

## License

This project is licensed under the Apache 2.0 License. See [LICENSE](LICENSE) for details.
