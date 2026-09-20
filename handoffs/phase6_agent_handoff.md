# Agent Handoff, Phase 6 (Authorization, safety, dashboard)

Branch `feat/phase-6-authz-safety-dashboard`. The **policy store is deployed and wired into
Amplify**; the **web code that calls it is not committed and not deployed**, so the live URL still
serves Phase 5 behaviour. Phase 7 task 2 (the demo seed) is done and has run against the real
table; the rest of Phase 7 is open.

## Read these first
- `apps/web/src/lib/authz.ts` — the `requireAuthz` helper and the two request-shape traps below.
  This file is owned by another agent in flight; do not edit it without asking.
- `apps/web/src/lib/dashboard.ts` — pure, band-only, no AWS client. The module boundary is what
  makes "a guardian cannot read a quote" a property rather than a UI decision.
- `apps/web/src/lib/audit.ts` — the same idea for the provenance table (phase 6 task 9).
- `apps/web/scripts/seed-demo.ts` — the demo seed. Its header explains why the score row is the
  one write that does not go through `lib/db/`.
- `infra/lib/chaukanna-stack.ts` — the policy store, schema and Cedar policies.

## The shape of it

```
guardian page / route handler
      ↓  resolveMember / getGuardianHousehold      (household check, unchanged)
      ↓  requireAuthz(principal, action, resource)
   Verified Permissions  ap-south-1  RdXE3H1ctJEqwZxTF4jNn6
      ↓  ALLOW → carry on      anything else, including an error → 403 (default deny)

dashboard reads:  listDrills + listScores → learnerProgress()  → points, steps, overall, weakest
audit reads:      listDrills + listScores + getLatestConsent   → buildAuditRows()
learner control:  POST /api/members/<id>/sharing → Member.transcriptSharing (off by default)
```

## Decisions worth knowing

- **The Cedar schema is wrapped in its namespace.** `CreatePolicyStore` takes
  `{"Chaukanna": {entityTypes, actions}}`, not `{entityTypes, actions}`. The unwrapped version is
  rejected with ``unknown field `Household`, expected one of commonTypes, entityTypes, actions,
  annotations``, which reads like a broken entity definition and is really the service reporting
  that it took `Household` for a namespace. Entity types on the wire are then namespace-qualified
  everywhere: `Chaukanna::Member`, never `Member`.
- **`IsAuthorized` takes bare `EntityIdentifier`s.** `principal` and `resource` are type and id
  only; attributes go in `entities.entityList` as their own entries keyed by the same identifier.
  Put them on the principal or the resource and the API accepts the call, silently drops them, and
  every `when`-guarded policy evaluates against an attribute-less entity and denies. It never
  errors. If nothing is ever permitted and the log shows a clean DENY, suspect the request shape
  before the policy text.
- **Verified Permissions is available in `ap-south-1`.** The phase's cross-region pitfall did not
  bite; the store lives with the rest of the data plane.
- **Nothing band-derived ever carries a quote.** `dashboard.ts` and `audit.ts` receive rows and
  return bands, dates, flag ids and counts. `turningPoint`, `debriefText` and every `evidence`
  string stay on the learner's screen (PRD F7 AC2).
- **The demo seed writes the score row itself.** `lib/db/scores.ts` is read-only on purpose, so
  the seed uses the same client, key builder and `Score` schema from the script rather than adding
  a write path to the app. Everything else — household, member, consent, window, drills — goes
  through the real helpers.
- **`tsx` is a new dev dependency of `apps/web`, one line, for the seed only.** Node 26 strips TS
  types but resolves relative imports as ESM, so the extensionless `./client` imports used
  throughout `lib/` cannot be run by `node` directly. The alternative was rewriting import
  specifiers across the app to suit a script.

## Verified
- `apps/web`: **242 tests, 20 files, green.** `npm run typecheck` and `npm run lint` clean.
- The Verified Permissions policy store exists in the account:
  `RdXE3H1ctJEqwZxTF4jNn6`, created 2026-09-20, and `POLICY_STORE_ID` is set on the Amplify
  `main` branch alongside `TABLE_NAME`, `AGENT_RUNTIME_ARN`, `RING_LAMBDA_ARN` and the rest.
- **The demo seed ran twice against the real `chaukanna` table** (`AWS_PROFILE=chaukanna`,
  `ap-south-1`). The second run reported every row already present, and the read-back through
  `lib/dashboard.ts` printed `at_risk -> safe`, overall `better`, weakest
  `Took the caller for a real official (x2)`, consent present. Household `50f31ba83580986b7341`,
  learner `e35d576e20adef50dfdb`, ownerSub `demo-seed-guardian`.

## Not verified, and it needs a deploy
- **Every Phase 6 file is uncommitted.** The audit page, the dashboard components, the sharing
  toggle, `authz.ts`, `audit.ts`, `dashboard.ts` and `kill-switch.test.ts` are working-tree
  changes on this branch. Amplify builds only the connected branch, so none of it is on the live
  URL until this merges into `main`.
- **No real `IsAuthorized` call has been made from the deployed app.** The policy store is
  deployed and the client code is written; the allow/deny pair the Phase 6 gate asks for on camera
  has not been demonstrated end to end.
- **The kill switch's four effects have not been watched together against the account** — pause,
  schedule deletion, pending drills cancelled, policy refusing a new one.
- **The accessibility pass (task 8) has not been done on a phone at arm's length.**
- `DEMO_MODE` is **not** set on the Amplify branch, so the judge demo button is off on the live
  URL. Setting it is a console change, not a deploy.

## Deploying this, in order
```bash
# 1. merge this branch into main; Amplify builds it
# 2. seed the demo household into the account the demo will sign in as
cd apps/web
AWS_PROFILE=chaukanna npm run seed:demo -- --owner-sub=<the Cognito sub you will demo with>
# 3. sign in at https://main.d22ofb6t13cyj2.amplifyapp.com and confirm the trend renders
```
Do not run `--wipe` against anything but the demo household; it deletes by derived key only, but
`--owner-sub` decides which household that is.

There is nothing new to `cdk deploy` for Phase 6 if the policy store is the only infra change and
it is already in the account. If `infra/lib/chaukanna-stack.ts` has drifted since, read the diff
before deploying — and the Phase 5 hazard still stands: **`cdk deploy ChaukannaVoiceStack`
without `AGENT_IMAGE` set will destroy the live AgentCore runtime.**

## Still open, inherited
- CI cannot deploy: the `chaukanna-github-deploy` role and the OIDC provider still do not exist.
  Both workflows skip cleanly rather than failing red.
- First caller audio at ~4.2 s against the PRD's 3 s (F4 AC2), untouched since Phase 3.
- The spoken break-character line is still deliberately absent; the drill ends on time, silently.
