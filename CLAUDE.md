# CLAUDE.md

Project: **Chaukanna**. Consented practice scam calls that train Indian families against digital arrest fraud.
Read `docs/PRD.md` before writing code. Read `docs/PHASES.md` to find out which phase is active. Read `docs/AGENT_PROMPTS.md` before touching a prompt.
Hackathon build, team of 4, public repository.

## Prime directives

1. **Safety code before feature code.** The tripwire, the safe word, the session cap and the window check exist and are tested before the persona gets interesting.
2. **Working beats complete.** Ship the current phase end to end before starting the next.
3. **Stay in the active phase.** If a task is not in the active phase file, ask before building it.
4. **NEW AGENTS: Strictly refer to the `handoffs/` directory files.** When starting work on new or next phases, read the handoff files left by previous agents for exact context and status.
5. **Never invent an API.** If unsure of an SDK shape, a model id, or a service limit, check the docs or the AWS sample repo. Confident wrong code costs more than a question.
6. **Two strikes then stop.** If an approach fails twice, report it and use the documented fallback.
7. **No secrets in the repo, ever.** This repository is public. Config comes from SSM Parameter Store and Secrets Manager at runtime, or from Amplify environment variables for non secrets.

## Stack, pinned, do not substitute

| Layer | Choice |
|---|---|
| Web and app API | Next.js 15 App Router, TypeScript, Tailwind, deployed on AWS Amplify Hosting |
| Server access to AWS | Amplify SSR **compute role**, AWS SDK v3, no access keys anywhere |
| Auth, guardian | Amazon Cognito user pool, hosted managed login |
| Auth, learner | Signed single use invite token. Learners never create an account |
| Authorization | Amazon Verified Permissions, Cedar policies |
| Data | One DynamoDB table plus one S3 bucket |
| Voice agent | Python 3.12, Strands Agents SDK `BidiAgent`, Amazon Nova 2 Sonic |
| Agent hosting | Amazon Bedrock AgentCore Runtime, WebSocket transport |
| Scoring | Step Functions with Python Lambdas, Bedrock Guardrails, a Bedrock judge model |
| Scheduling | EventBridge Scheduler one time schedules |
| IaC | AWS CDK v2 TypeScript in `infra/` |
| CI/CD | Amplify Hosting git integration for web, GitHub Actions with OIDC for infra and agent |

Regions: app and data in `ap-south-1`, voice path in `ap-northeast-1` because Nova 2 Sonic is not in Mumbai. Never hardcode a region, read `AWS_REGION` and `VOICE_REGION`.

Do not add: API Gateway, Lambda for CRUD, App Runner, ECS, a VPC, a NAT gateway, Postgres, Prisma, Redis, a queue, or any auth library. If you think you need one, you are solving a scale problem this project does not have.

## Repo map

```
chaukanna/
  apps/
    web/                 Next.js app, UI and route handlers
    agent/               Python drill agent for AgentCore Runtime
  services/
    scoring/             Step Functions task Lambdas (Python)
    video/               VideoProvider interface only, no implementation in the MVP
  infra/                 CDK app
  docs/                  PRD, PHASES, ARCHITECTURE, AGENT_PROMPTS, guides, phases/
  fixtures/              recorded transcripts and synthetic utterances
  .github/workflows/     deploy-infra.yml, deploy-agent.yml
```

One owner per top level folder. If another package's interface is wrong, change the interface and tell its owner, do not work around it.

## Commands

```bash
# web
cd apps/web && npm install && npm run dev          # http://localhost:3000
npm run typecheck && npm run lint && npm run build

# agent
cd apps/agent && uv sync
uv run python -m chaukanna_agent.local             # local mic drill
uv run pytest                                      # fixture replay

# scoring
cd services/scoring && uv run pytest

# infra
cd infra && npm run build && npx cdk diff && npx cdk deploy --all
```

`cdk deploy` is manual and deliberate, or run by the GitHub Actions workflow. Never call it from another package's script.

## Environment

Non secret values come from Amplify environment variables or CDK outputs. Secrets come from SSM or Secrets Manager at runtime.

| Name | Used by |
|---|---|
| `AWS_REGION` | everything, `ap-south-1` |
| `VOICE_REGION` | web, agent, `ap-northeast-1` |
| `TABLE_NAME`, `ARTIFACTS_BUCKET` | web, scoring |
| `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `COGNITO_DOMAIN` | web |
| `POLICY_STORE_ID` | web |
| `AGENT_RUNTIME_ARN` | web |
| `SONIC_MODEL_ID` | agent, default `amazon.nova-2-sonic-v1:0` |
| `JUDGE_MODEL_ID`, `GUARDRAIL_ID`, `GUARDRAIL_VERSION` | scoring |
| `SCORING_STATE_MACHINE_ARN` | agent |
| `INVITE_SIGNING_KEY` | web, from Secrets Manager |
| `SESSION_MAX_SECONDS` (360), `SAFE_WORD` (ROKO) | agent |

`.env.example` is committed. `.env.local` is not. If a key appears in a diff, stop and rotate it.

## Conventions

- TypeScript strict. No `any` without a comment explaining the third party gap.
- Python type hints on public functions, `ruff` clean, `pydantic` models across boundaries.
- One structured JSON log line per meaningful event, always carrying `drillId`. No `console.log`, no `print` in merged code.
- Route handlers are thin: parse, authorize, call a function in `lib/`, return. Business logic lives in `lib/`, and `lib/` is unit testable without Next.js.
- Every DynamoDB access goes through `lib/db/` helpers. No raw client calls scattered in routes.
- No new dependency without a one line reason in the PR.
- Tests live next to what they test. A bug fix ships with the fixture that reproduced it.

## Product rules that are also code rules

1. The tripwire runs on the transport layer, not in the prompt. A prompt is not a control.
2. Never persist raw audio or transcript before redaction.
3. Never build a data collection surface inside a drill: no input, no link, no upload.
4. Never generate or render real agency emblems, uniforms, officer names, case numbers, or a real person's likeness.
5. Default deny in authorization. If the policy call fails, the answer is deny.
6. The learner never needs a password, an email client, or an app store.
7. No camera access anywhere in the MVP.

## Definition of done

- Works on the deployed environment, not just locally
- Failure path handled and logged
- Has a test, a fixture, or a documented manual check in the PR
- Does not widen scope beyond the active phase
- `npm run typecheck`, `npm run lint` and `ruff` clean, CDK diff understood by whoever deploys

## Known pitfalls

- Nova Sonic bidi needs Python 3.12 or newer. 3.11 fails confusingly.
- Nova 2 Sonic is not available in `ap-south-1`. Voice calls go to `ap-northeast-1`.
- Bedrock model access is granted per region in the console before any call works.
- Model sessions have a duration limit. Build the reconnect before the persona.
- Amplify SSR needs a compute role attached for any AWS SDK call from a route handler. Without it you get AccessDenied at runtime, not at build.
- Amplify builds only what is in the connected branch. A green local build proves nothing about the deploy.
- EventBridge Scheduler one time schedules need explicit deletion, otherwise cancelled drills still fire.
- Bedrock Data Automation does not list Hindi. If you ever need Hindi transcription outside the Sonic session, use Amazon Transcribe.

## Hackathon compliance

- Every commit inside the event window, from that member's own account
- Any sample, template or snippet gets a credit line in the README with its licence
- The README lists every AI coding tool used
- Do not copy code from any team member's earlier projects. Reimplement
- Each person adds to `LEARNINGS.md` as they go. The judging criteria score it
