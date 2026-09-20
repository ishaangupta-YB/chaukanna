# Agent Handoff, Phase 6 (Authorization, safety, dashboard)

**Phase 6 is complete and its gate passes on the deployed system.** Everything below was
demonstrated against `https://main.d22ofb6t13cyj2.amplifyapp.com` and the live policy store, not
only in tests.

> This file replaces an earlier version that said the Phase 6 web code was uncommitted and that no
> real `IsAuthorized` call had been made from the deployed app. Both were true when it was
> written and neither is true now.

## The gate, as it was proven

Run against the live URL with a demo session, in this order:

| Step | Result |
|---|---|
| Schedule a drill for an **active** learner | policy ALLOWs; refused later by `weekly_cap` (409), not by policy |
| Kill switch: `POST /api/members/<id>/pause-all` | `{"status":"paused","cancelled":1}` |
| Member row | `status: paused` |
| Pending drill row | `cancelled` |
| EventBridge Scheduler | zero schedules remaining |
| Schedule a drill for the **paused** learner | **403 `authz_denied`** — the Cedar `forbid`, from the deployed store |
| "Ring now" for the same learner | **403 `authz_denied`** — same policy, other path |

That is all four kill-switch effects and the policy refusing a new drill, in one sequence, from
the deployed system. It is the 60 seconds of screen recording the phase asks for.

Eleven allow/deny cases were also run directly against policy store `RdXE3H1ctJEqwZxTF4jNn6`
using the app's own `lib/authz.ts` — guardian band, guardian transcript with sharing off and on,
learner's own transcript, learner `TakeDrill`, stranger denied on all three, paused schedule
denied, plus the batched `ViewBand` path keeping own-household drills and dropping a foreign one.
All green.

## What changed to get there

The six Cedar policies and the schema were already deployed and correct. What was missing was
that the running app never asked about three of the four actions.

- **`ScheduleDrill` was enforced by a branch, not a policy.** `guardNewDrill` refused a paused
  member with an `if`. Right answer, wrong mechanism: a branch cannot be shown denying, cannot
  change without a deploy, and drifts the first time somebody reorders the guards. The route now
  calls `requireAuthz` **before parsing the body**, carrying the member's live `status` so the
  `forbid` can fire.
- **`TakeDrill` was dead.** `POST /api/drills/[id]/session` now asks it.
- **`ViewBand` was never asked on the two screens that read drills.** `/app` and `/app/audit` now
  authorize every drill they render, through `lib/guardian-view.ts`.

## The trap that will bite you again

**A batch API is a different IAM action from its singular form and is never implied by it.**

The compute role had `dynamodb:GetItem` and `verifiedpermissions:IsAuthorized`. It did not have
`dynamodb:BatchGetItem` (which `listScores` calls) or `verifiedpermissions:BatchIsAuthorized`
(which the dashboard's authorization calls). Consequences:

- `/app` and `/app/audit` returned **500 for any household that had ever run a drill**. This
  predates Phase 6 and was never seen because an empty demo household exercises neither call, so
  the dashboard looked perfect right up until it had data.
- It is invisible locally and in CI, because both run as an admin identity that may call both.

Verify with one action per call — the API refuses two VP actions in one request:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<acct>:role/chaukanna-amplify-compute-role \
  --action-names dynamodb:BatchGetItem \
  --resource-arns arn:aws:dynamodb:ap-south-1:<acct>:table/chaukanna \
  --query 'EvaluationResults[0].EvalDecision' --output text     # allowed | implicitDeny
```

Both call sites now fall back to the singular form when the batch action is denied, so the
screens work under either configuration. **The CDK grant is fixed but not deployed** — see below.

The same audit found two more gaps with no possible code workaround: the **scoring debrief**
Lambda could not read the redacted transcript it quotes (so every drill would end with a band and
silence), and the **ring** Lambda could not write its own audit row (so it threw after flipping
the drill, and EventBridge retried). Both are fixed in CDK and covered by
`infra/test/infra.test.ts`. See `handoffs/phase7_agent_handoff.md`.

## The one thing still owed

`infra/lib/chaukanna-stack.ts` now grants `dynamodb:BatchGetItem` and
`verifiedpermissions:BatchIsAuthorized` on the compute role. That change is **committed and not
deployed**. The diff is those two actions on one IAM policy and nothing else:

```bash
cd infra
AWS_PROFILE=chaukanna AWS_REGION=ap-south-1 npx cdk diff ChaukannaStack     # read it first
AWS_PROFILE=chaukanna AWS_REGION=ap-south-1 npx cdk deploy ChaukannaStack
```

It is an optimisation, not a fix: without it the fallbacks run and the screens work, one request
per drill instead of one per screen. With it, one call.

**Always pass `AWS_PROFILE` and `AWS_REGION` to cdk.** Without them the CLI resolves the region
from the default profile, synthesises into `us-east-1`, finds nothing there and reports the
entire stack as new. A diff that says `[+]` for every resource is a wrong target, not a big
change — and a deploy from it creates a duplicate stack in the wrong region.

**The Phase 5 hazard still stands:** `cdk deploy ChaukannaVoiceStack` without `AGENT_IMAGE` set
destroys the live AgentCore runtime. Deploy `ChaukannaStack` by name, never `--all`.

## Where the code lives

```
lib/authz.ts          requireAuthz (one decision) + authorizedQueries (a list, batched,
                      falling back to singles when BatchIsAuthorized is denied)
lib/guardian-view.ts  authorizedDrills: which drills a guardian may see the outcome of.
                      Returns `available: false` when the check could not run, which the
                      screens render as a notice — never as "no practice calls yet".
lib/dashboard.ts      pure, band-only, no AWS client
lib/audit.ts          the same idea for the provenance table
lib/db/scores.ts      read-only; BatchGetItem with a per-drill fallback
```

`dashboard.ts` and `audit.ts` receive rows and return bands, dates, flag ids and counts. No quote
can cross out of them, so "a guardian cannot read a transcript" is a property of the module
boundary rather than a UI decision (PRD F7 AC2).

## Accessibility (task 8)

Done, and held by `src/components/learner/accessibility.test.ts` rather than by having looked
once. Every learner string is ≥20px and every learner control ≥48px; eighteen strings were at
18px, almost all error messages, copied in from guardian components where 18px is fine. The test
also allowlists the three screens permitted a timer, so a new countdown on a learner screen fails
the suite.

## Retention (task 6), for the camera

`s3://chaukanna-artifacts-<ACCOUNT_ID>`, all rules Enabled:
`drill-audio-7-days`, `drill-transcript-30-days`, `drill-redacted-30-days`, `debrief-90-days`,
`consent-365-days`, `abort-incomplete-uploads`.

## Test data left behind

One demo household, `HH#12e25b5c08532f1277ec` / member `0f73001abb2ed523affc`, created by the
live gate run above. Its `ownerSub` begins with `demo-`, it is paused with one cancelled drill,
and demo sessions carry a 2 hour TTL. Harmless; delete it if you want a clean audit log on camera.

## Still open, inherited

- CI: the OIDC provider and the `chaukanna-github-deploy` role **now exist** in the account with
  a trust policy scoped to `repo:ishaangupta-YB/chaukanna:*`. What was not confirmed from here is
  whether the `AWS_ROLE_TO_ASSUME` repository secret is set; without it both workflows skip
  cleanly rather than failing.
- First caller audio at ~4.2 s against the PRD's 3 s (F4 AC2), untouched since Phase 3.
- The spoken break-character line is still deliberately absent; the drill ends on time, silently.
