# Agent Handoff

Welcome, next agent! I have completed **Phase 0 (Foundations)**. You are taking over the repository to begin work on the next phases. Here is exactly what I implemented and how you should proceed.

## Phase 0: Foundations (What I Implemented)

I successfully passed the Phase 0 gate based on `docs/phases/PHASE_0_FOUNDATIONS.md`.
- **Monorepo Setup**: Scaffolded the repository with `apps/web` (Next.js 15), `apps/agent` (Python uv), `services/scoring` (Python uv), `services/video` (Python placeholders), and `infra` (AWS CDK TS). 
- **AWS CDK Infrastructure**: Created `infra/lib/chaukanna-stack.ts`. It includes:
  - DynamoDB Table (`chaukanna`) with PAY_PER_REQUEST billing, `ttl` time-to-live attribute, and a `GSI1` index.
  - S3 Bucket for artifacts with strict lifecycle rules (consent 365d, drill 7d, debrief 30d).
  - Cognito User Pool, Client ID, and Domain.
- **CI/CD**: Wrote two GitHub Action workflows (`.github/workflows/deploy-infra.yml` and `deploy-agent.yml`) per the `DEPLOYMENT.md` guide. Note: The workflows have been staged/committed but could not be pushed to remote due to the user's PAT lacking the `workflow` scope.
- **Next.js & API Health Check**: Created the Next.js App Router and set up the `/api/health` route. It correctly responds without failing. I resolved ESM compatibility issues with Next 15's ESLint config using `@eslint/eslintrc` `FlatCompat`.
- **Security Check passed**: I ran deep secrets scans (`grep -rIE "aws_secret|AKIA|..."`). Absolutely no real AWS Account IDs or tokens are hardcoded. `.env` and `.env.local` are explicitly in `.gitignore`. Also, `docs/` is explicitly in `.gitignore` to keep internal project documentation out of the public repo.

## Your Immediate Tasks (Phase 1: Domain and Consent)

Your next target is **Phase 1**, based on `docs/phases/PHASE_1_DOMAIN_AND_CONSENT.md`.

**The Phase 1 Goal**: A guardian can sign in, create a household, invite a learner, and the learner can consent from their own phone.
**The Phase 1 Gate**: On the deployed URL: guardian signs up, invites, opens the invite link on a phone, consents with a recorded voice line, and sets a window. All rows visible in DynamoDB.

1. **Cognito Wiring**: Implement Hosted Managed Login for Cognito, verify JWTs in a small `lib/auth.ts` without using external auth libraries.
2. **Data Access Layer**: Implement `lib/db/` with typed TypeScript helpers (`putHousehold`, `getHousehold`, `putMember`, `putConsent`, etc.) using Zod for validation.
3. **Invite Tokens**: Implement the HMAC SHA256 based single-use invite tokens as specified in the docs.
4. **Screens**: Build the guardian UI (household dashboard, add member) and the learner onboarding UI (invite link handler, consent page with media recorder for audio, window selector).
5. **Update LEARNINGS**: Update the Phase 1 block in `LEARNINGS.md` after completion.

## Crucial Tips for Next Agent
- **Always read the Phase docs** before starting any implementation (e.g., `docs/phases/PHASE_1_DOMAIN_AND_CONSENT.md` or `PHASE_2_AGENT_LOCAL.md`).
- **Never expose secrets**: Keep the security hygiene exactly as I left it. No secrets in the repo.
- **Environment Context**: Python is managed using `uv`. Next.js is version 15.
- The user is deploying infrastructure locally for the hackathon using `cdk deploy`. Do not assume automatic infrastructure updates via CI until the pipeline is completely set up by the user.

Good luck!
