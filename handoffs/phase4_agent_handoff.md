# Agent Handoff, Phase 4 (Drill lifecycle and scheduling)

Branch `feat/phase-3-agent-browser`, pushed (Phase 4 commits sit on top; nothing has been
rebased). Code complete, every suite green, and **`ChaukannaStack` is deployed**: `cdk diff`
reports no differences, the ring Lambda is `Active`, and a real one-time schedule invoked it.

What is still missing is the *product* end: there is no Amplify app, so no deployed URL, so the
gate — a drill that rings on its own while nobody is watching — has not been run by a human.

## Read these first
- `apps/web/src/lib/drills.ts` — `scheduleDrill`, `ringNow`, `cancelPendingDrills`, `settleDrill`.
  Every rule that decides whether a phone rings is still in this one file.
- `apps/web/src/lib/schedule.ts` — all the time maths, pure and self-contained. Its inverse of
  `Intl` (civil time back to an instant) is the fiddly part; 23 tests pin it.
- `services/lifecycle/lifecycle_service/ring.py` — the Lambda the schedule invokes.
- `infra/lib/chaukanna-stack.ts` sections 9 to 12.

## The shape of it

```
POST /api/members/[id]/drills {schedule:true}
  → guardNewDrill(requireInsideWindow=false) → randomInstantInWindow → putDrill(scheduled)
  → scheduler:CreateSchedule chaukanna-drill-<drillId>  → event drill.scheduled
      ↓ (EventBridge, Asia/Kolkata wall clock)
  ring Lambda: re-check status + consent + window → UpdateItem scheduled→due (conditional)
  → event drill.due → SES nudge to the guardian (best effort)
      ↓
  learner's /me poll sees `due` → ring screen → Phase 3 takes over
```

## Decisions worth knowing

- **The window is not checked when a drill is scheduled, only when it fires.** Scheduling at
  10:00 a call that rings at 14:20 is the entire feature; the original single guard refused every
  drill created outside the learner's hours. `guardNewDrill` now takes `requireInsideWindow`,
  true for "ring now" and false for scheduling. The ring Lambda checks it for real.
- **Cancellation marks the row first, deletes the schedule second.** A schedule that outlives a
  cancellation is harmless because the Lambda re-reads the row; a drill that outlives its
  schedule would never be stopped. If `DeleteSchedule` fails it is logged and the drill stays
  cancelled.
- **"Ring now" is rate limited to once per ten minutes per member**, counting cancelled drills.
  Cancelled drills do not count against the weekly cap, so without this a declined call could be
  followed immediately by another one.
- **`missed` is evaluated lazily**, on `GET /api/drills/[id]` and on the `/me` poll, conditional
  on `dueExpiresAt` having passed. A learner tapping answer in the same second wins.
- **The nudge email goes to the guardian, not the learner.** No learner address exists anywhere
  in Chaukanna and none was added: the guardian's Google address is already verified and is now
  stored on the household row (`ownerEmail`), refreshed on sign-in only when it changes. The
  phase file says "in the learner's language"; that half is deliberately not implemented, and
  this is the one place Phase 4 departs from its spec.
- **`dueExpiresAt` is a plain attribute, never `ttl`.** Writing `ttl` on a drill row would delete
  the drill instead of expiring its ring.
- **Lifecycle events are keyed `EVT#<iso>#<name>`** in the same partition as the agent's in-call
  events (`EVT#000004`). A zero-padded integer can never collide with an ISO date. They do not
  interleave in sort order; every row carries its own `at`, so sort on that.
- **No pydantic in the Lambda.** `Code.fromAsset` ships the source tree and installs nothing; the
  runtime has boto3 and botocore only. `parse_ring_event` validates by hand and says why.

## Verified
- Web 141 tests (21 new in `lifecycle.test.ts`, 23 new in `schedule.test.ts`), infra 38 (13 new),
  lifecycle 42, agent 173 passed / 3 skipped, scoring 1. Typecheck, lint, ruff, production build.
- `cdk synth ChaukannaStack` exits 0; the Lambda asset is 48 KB of source only — no `.venv`, no
  tests, no lock file.
- IAM reviewed: no wildcard actions. Compute role may create/delete/get `chaukanna-drill-*`
  schedules and `iam:PassRole` exactly the scheduler role, conditioned on
  `iam:PassedToService=scheduler.amazonaws.com`. The scheduler role's trust carries
  `aws:SourceAccount`. The Lambda may send only from the configured address.

## Verified on the deployed account
- `ChaukannaStack` is deployed and `cdk diff` reports **no differences** from this branch.
- `chaukanna-ring` is `Active`, python3.12, arm64, handler `lifecycle_service.ring.handler`.
  Invoked with an id that does not exist it returns `{"status": "gone"}` — which also proves the
  import works, the thing the pydantic removal was about.
- A real one-time EventBridge schedule, created with the deployed scheduler role and an
  `at(...)` expression in `Asia/Kolkata`, invoked the Lambda by itself **10 seconds after its
  stated time**, and then deleted itself (`ActionAfterCompletion: DELETE`), leaving zero
  schedules in the account. That closes three pitfalls at once: the role can be passed, the
  local-wall-clock expression is accepted, and spent schedules do not pile up. Expect that ten
  second lag in the demo — Scheduler is "within a minute", not to the second.
- `SENDER_EMAIL` is empty on the deployed function, so the nudge is off. That is a valid state.
- Voice path unchanged and healthy: AgentCore runtime `chaukanna_drill` is `READY` in
  `ap-northeast-1`, and `amazon.nova-2-sonic-v1:0` reports `AUTHORIZED` / `AVAILABLE` there.

## Not verified, and it needs you
1. **There is no Amplify app**, so no deployed URL. Everything below waits on it. Env vars are
   now nine: the Phase 1 five, `VOICE_REGION`, `AGENT_RUNTIME_ARN`, plus `RING_LAMBDA_ARN` and
   `SCHEDULER_INVOKE_ROLE_ARN` from `cdk-outputs.json`. Scheduling fails without the last two;
   "Ring now" does not.
2. **The gate.** Widen a member's window to cover the next ten minutes, press *Schedule a
   practice call*, walk away, and let it ring on its own. Then schedule another and revoke
   consent: the row must be `cancelled` and the schedule gone inside a minute.
3. **CI cannot deploy anything yet.** Both workflows trigger on a push to `main` touching
   `infra/**` or `apps/agent/**`, and both assume `chaukanna-github-deploy` through GitHub OIDC.
   Neither the IAM OIDC provider nor that role exists in the account, and the repository has no
   `AWS_ROLE_TO_ASSUME` secret. Merging Phase 1 to 4 into `main` therefore starts two runs that
   fail at the credentials step. Nothing deployed breaks; the Phase 0 gate's "CI deploys infra"
   half is simply not done. `docs/AWS_SETUP.md` section 8 has the provider, the role and the
   repository-scoped trust policy.
4. Re-deploy with `-c chaukanna:senderEmail=<address>` to turn the nudge on. SES starts in the
   sandbox, so verify the sender and the guardian address, or the mail silently goes nowhere —
   which the Lambda logs as `ring.email_skipped` rather than failing the ring.
   See `docs/AWS_SETUP.md` section 11.

## What "test it on a phone" actually means

No phone *number* is involved anywhere in Chaukanna. Nothing dials the PSTN, there is no
telephony provider, and a learner's number is never asked for or stored. A "call" is a WebSocket
from a browser tab to AgentCore, dressed up as a ring screen. What the gate needs is a **mobile
device with a browser and a microphone**, opened on the invite link.

Mobile data rather than wifi is not because wifi fails — it is because wifi is the easy case and
proves the least. A phone on a mobile network is behind carrier NAT, changes IP when it moves
between towers, and delivers audio with jitter and loss that a desk on wifi never sees. It is
also the only way to check the two failure paths honestly: pulling the learner off wifi mid-call
is how you find out whether a dropped socket ends the drill with an explanation (and is recorded
as `error`, never as the `hangup` the rubric credits), and a second phone on a different network
in a different city is how you find out whether anything was quietly relying on a shared LAN.
Run the happy path on wifi if that is convenient; run the gate on mobile data.

## Still open from Phase 3
First caller audio at ~4.2 s against the PRD's 3 s (F4 AC2). Untouched by this phase.
