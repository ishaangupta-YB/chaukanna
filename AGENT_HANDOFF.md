# Agent Handoff

Welcome, next agent! This document provides context on what has been accomplished so far and what is expected next.

## Current State (Phase 0 Completed)
- **Monorepo Scaffolded**: The repository `chaukanna` has been set up with `apps/web` (Next.js 15), `apps/agent` (Python uv), `services/scoring` (Python uv), `services/video` (Python), and `infra` (AWS CDK TS).
- **AWS Infrastructure**: The CDK stack (`infra/lib/chaukanna-stack.ts`) has been written, covering DynamoDB (with GSI1), an S3 artifacts bucket, and a Cognito User Pool setup.
- **CI/CD**: GitHub action workflows (`deploy-infra.yml`, `deploy-agent.yml`) are in the `.github/workflows/` directory. They were temporarily un-tracked from the remote because the user's PAT needs the `workflow` scope to push them.
- **Web App**: Next.js app has a health check route (`/api/health`) configured.
- **Security**: The repository has been scanned for secrets. `docs/` is explicitly `.gitignore`'d and kept private.

## Important Context & Quirks
- **ESLint & Next.js 15**: Ran into ESM compatibility issues with Next.js 15's ESLint config. Solved by using `@eslint/eslintrc` `FlatCompat`.
- **Node Modules / Python Venvs**: `uv` is being used for Python dependency management. Node versions and Next.js require proper paths in commands.
- **Deployment**: The user needs to manually run `cd infra && npx cdk deploy` locally to bootstrap/deploy the stack the first time, and hook up Amplify in the console.

## Next Steps (Phases 1 & 2)
The next immediate steps based on the project documentation are:
1. **Phase 1 (Domain & Consent)**: Likely involves setting up the Next.js frontend pages, connecting the frontend to Cognito for auth, and implementing the consent flow.
2. **Phase 2 (Agent Local)**: Requires building the actual Bedrock AgentCore logic in `apps/agent/` and getting it running locally.
3. Check `docs/phases/PHASE_1_DOMAIN.md` and `docs/phases/PHASE_2_AGENT_LOCAL.md` (if they exist) for specific requirements.

## Instructions for Next Agent
- **Always read the Phase docs** before starting implementation.
- Maintain the strict security posture: **no AWS account IDs or secrets** in committed code (`.env.local` is gitignored).
- Remember to update `LEARNINGS.md` after you finish your designated phase!
