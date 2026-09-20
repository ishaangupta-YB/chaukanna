# Agent Handoff, Phase 7 (Demo and submission)

Phases 0 through 6 are built and deployed. **Phase 6's gate passes on the deployed system**; see
`handoffs/phase6_agent_handoff.md` for how it was proven and what it cost.

What remains in Phase 7 needs people: a phone, a microphone, a camera, and accounts nobody but
the team can sign into.

## State of the deployed system

| Thing | Where | State |
|---|---|---|
| Web app | Amplify `d22ofb6t13cyj2`, branch `main`, `ap-south-1` | live, `WEB_COMPUTE`, `/api/health` returns `ACTIVE` |
| Data | DynamoDB `chaukanna` + `s3://chaukanna-artifacts-<ACCOUNT_ID>` | live, 6 lifecycle rules Enabled |
| Authorization | Verified Permissions `RdXE3H1ctJEqwZxTF4jNn6` | live, 6 Cedar policies, all 4 actions enforced |
| Voice agent | AgentCore runtime `chaukanna_drill`, `ap-northeast-1` | `READY` |
| Scoring | Step Functions `chaukanna-scoring`, 5 Lambdas, guardrail `chaukanna-drill-redaction` | deployed, guardrail `READY`, **zero executions** |
| Scheduling | `chaukanna-ring` Lambda + EventBridge Scheduler | live |
| CI | GitHub OIDC provider + `chaukanna-github-deploy`, trust scoped to `repo:ishaangupta-YB/chaukanna:*` | role exists; `AWS_ROLE_TO_ASSUME` repo secret unconfirmed |
| `DEMO_MODE` | Amplify branch env var | **on** — a public auth bypass; turn it off after judging |

## Read this before you deploy or record: four permission gaps

A full audit of every AWS API call in the repo against every runtime role found **four grants
missing**, all the same shape, none visible from the code, a local run, a green test suite or a
successful deploy. All four are fixed in `infra/lib/chaukanna-stack.ts` and **none of them is
deployed**.

| Role | Missing | What breaks without it |
|---|---|---|
| Amplify compute | `dynamodb:BatchGetItem` | `/app` and `/app/audit` **500** for any household that has run a drill |
| Amplify compute | `verifiedpermissions:BatchIsAuthorized` | the dashboard's authorization call |
| Scoring debrief | `s3:GetObject` on `drill/redacted/*` | **every drill ends with a band and silence** |
| Ring Lambda | `dynamodb:PutItem` (scoped to `DRILL#*`) | ring throws after flipping the drill, EventBridge retries, audit log loses a row per drill |

The two web ones now have code fallbacks, so those screens work either way. **The other two do
not and cannot** — a Lambda that may not read a file cannot work around it.

```bash
cd infra
AWS_PROFILE=chaukanna AWS_REGION=ap-south-1 npx cdk diff ChaukannaStack    # four IAM adds, nothing else
AWS_PROFILE=chaukanna AWS_REGION=ap-south-1 npx cdk deploy ChaukannaStack
```

`test/infra.test.ts` now pins every runtime role to the calls its handler makes, scoped per role
— the unscoped version of that test passes on a *different* role's identical grant and would have
missed the debrief one entirely.

Why none of this was caught: local runs and CI use a developer identity that can call everything;
an empty demo household exercises none of the batch paths; and the scoring pipeline had never
executed at all. **Exercise the deployed system with data in it.** "It works on the deployed URL"
and "it works for an account that has done something" are different claims.

## The one real risk before you record

**The scoring pipeline has never run.** Not once, not in staging, not with a fixture. Every part
of it is deployed and healthy, but `chaukanna-scoring` has zero executions, the Bedrock guardrail
has never been called, and no `apply_guardrail`, judge or Polly call has ever been made from a
Lambda in this account.

The demo seed writes its score rows directly (`lib/db/scores.ts` is read-only on purpose), so a
dashboard showing `at_risk -> safe` proves the dashboard, not the pipeline. The video asks for a
debrief at 1:30 and a Step Functions execution graph at 2:05, and today there is nothing behind
either.

**Do this before anything else.** Start one execution against a fixture transcript and watch it
go green. Input shape, from `services/scoring/scoring_service/handlers.py`:

```json
{ "drillId": "<hex>", "memberId": "<hex>", "scheduledAt": "<iso>", "transcriptKey": "<s3 key>" }
```

`services/scoring/scoring_service/cli.py` runs the identical code path locally against
`fixtures/transcripts/*.json` and defaults to `--dry-run`, so start there — but a green CLI run
does **not** prove the deployed pipeline, for exactly the reason Phase 6's IAM bug proves: the
CLI runs as you, the Lambdas run as their own roles. Check each scoring Lambda's role against the
APIs it actually calls before you trust it.

If the pipeline cannot be made to run in time, say so in the writeup and cut the Step Functions
shot. A fabricated graph is worse than an honest gap, and the judging criteria reward teams that
name their own risks.

## The 60 seconds of Phase 6, exactly as it was run

This is the safety sequence, reproducible from a terminal against the live URL. Run it once
before recording so you know the shape, then do it on screen through the UI.

```bash
U=https://main.d22ofb6t13cyj2.amplifyapp.com
curl -s -c cj.txt -X POST "$U/api/demo/start" -H "origin: $U" \
  -H 'content-type: application/x-www-form-urlencoded' --data ''      # 303 -> /app
M=<the memberId on the dashboard>

curl -b cj.txt -X POST "$U/api/members/$M/drills" -H "origin: $U" \
  -H 'content-type: application/json' -d '{"now":true}'               # 201, policy allowed
curl -b cj.txt -X POST "$U/api/members/$M/pause-all" -H "origin: $U"  # {"status":"paused","cancelled":1}
curl -b cj.txt -X POST "$U/api/members/$M/drills" -H "origin: $U" \
  -H 'content-type: application/json' -d '{"schedule":true}'          # 403 {"error":"authz_denied"}
```

That last 403 is Cedar, from the deployed policy store, not a branch in a route. It is the shot.

On screen, the same thing is: dashboard → *Stop all practice calls* → the member card turns
`Paused` and the scheduled call disappears → *Schedule a practice call* is refused. Have the
Verified Permissions console open on `RdXE3H1ctJEqwZxTF4jNn6` with the two `ScheduleDrill`
policies visible, so the `forbid` is on screen next to the refusal.

## The trend on camera

A demo-login session mints a **fresh random identity per click**, so it always starts with an
empty dashboard. The seeded `at_risk -> safe` trend lives under `demo-seed-guardian` and a demo
session will never see it.

To get the trend on screen, sign in with Google, take your Cognito sub, and seed into your own
household:

```bash
cd apps/web
AWS_PROFILE=chaukanna npm run seed:demo -- --owner-sub=<your cognito sub>
```

Re-running is a no-op; ids are derived, not random.

## Console tabs worth having open at 2:05

- **AgentCore**, `ap-northeast-1`, runtime `chaukanna_drill` — a live session during the drill
- **Step Functions**, `ap-south-1`, `chaukanna-scoring` — an execution graph (see the risk above)
- **Verified Permissions**, `ap-south-1`, `RdXE3H1ctJEqwZxTF4jNn6` — the six policies, with the
  `ScheduleDrill` `forbid` visible
- **S3**, `chaukanna-artifacts-<ACCOUNT_ID>` → Management → Lifecycle rules — six rules, named so
  they read on screen: `drill-audio-7-days`, `drill-transcript-30-days`, `drill-redacted-30-days`,
  `debrief-90-days`, `consent-365-days`

The lifecycle tab takes five seconds and answers the question every judge asks about a system
that records a grandmother's voice.

## Checklist, honest

- [x] Task 1, freeze — `main` is the demo branch; only fixes with a named owner from here
- [x] Task 2, seed the demo — `apps/web/scripts/seed-demo.ts`, has run against the real table
- [ ] Task 3, rehearse the drill three times — **needs a person and a phone**
- [ ] Task 4, record the video — **needs people**
- [ ] Task 5, writeup
- [ ] Task 6, blog on AWS Builder Center
- [x] Task 7, repository polish — README, credits with licences, AI tools list, `LEARNINGS.md`,
      and a full-history secret scan that came back clean (the only matches are the pre-commit
      hook's own detection regex)
- [ ] Task 8, submit early — **cannot be done from here**
- [ ] Task 9, eligibility check — **all four must register individually**

## Two things to do before you publish anything

1. **Deploy the four IAM grants** (above). Two of them have no code workaround: without them
   there is no spoken debrief and the ring Lambda errors on every scheduled drill.
2. **Turn `DEMO_MODE` off** on the Amplify branch once judging is over. It is a well-built bypass
   — fresh random identity per click, a `demo-` key space a Cognito subject cannot address, a
   2 hour TTL — but it is still an unauthenticated route into a real deployment.


## Test data left behind

Demo household `HH#12e25b5c08532f1277ec`, member `0f73001abb2ed523affc`: paused, one cancelled
drill, from the live Phase 6 gate run. Delete it if you want a clean audit log on camera.
