# Agent Handoff, Phase 4 (Drill lifecycle and scheduling)

Branch `feat/phase-3-agent-browser` (Phase 4 commits sit on top; nothing has been rebased).
Code complete, every suite green, `cdk synth` clean. **Not deployed**: `cdk deploy` and the
walk-away test are the owner's, and the gate cannot pass without them.

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

## Not verified, and it needs you
1. `cdk deploy ChaukannaStack` — the whole phase is unproven until it runs. Add
   `-c chaukanna:senderEmail=<address>` to get the nudge; without it the Lambda skips the email
   and everything else still works. See `docs/AWS_SETUP.md` section 11.
2. Copy `RingLambdaArn` and `SchedulerInvokeRoleArn` from `cdk-outputs.json` into
   `apps/web/.env.local` and into Amplify as `RING_LAMBDA_ARN` and `SCHEDULER_INVOKE_ROLE_ARN`.
   Scheduling fails without them; "Ring now" does not.
3. **The gate.** Widen a member's window to cover the next ten minutes, press *Schedule a
   practice call*, walk away, and let it ring on its own. Then schedule another and revoke
   consent: the row must be `cancelled` and the schedule gone inside a minute.
4. `SES` is in the sandbox. Verify the sender and the guardian address, or the mail silently
   goes nowhere — which the Lambda logs as `ring.email_skipped` rather than failing the ring.

## Still open from Phase 3
First caller audio at ~4.2 s against the PRD's 3 s (F4 AC2). Untouched by this phase.
