# Contributing to Chaukanna

## Branch Strategy & Pull Request Rules

1. **Short-lived branches:** Create feature branches off `main` (e.g. `feat/phase1-consent`, `fix/dynamo-ttl`).
2. **PR into `main`:** All changes must go through a Pull Request. Direct pushes to `main` are discouraged.
3. **Automated Verification:**
   - For web: `npm run typecheck && npm run lint && npm run build` must pass.
   - For infra: `npm run build && npm test && npx cdk synth` must succeed.
   - For python services: `uv run pytest` must pass cleanly.
4. **No secrets:** Never commit `.env`, AWS credentials, or API keys. Public repo rules apply at all times.
5. **Phase-focused:** Never widen scope beyond the active phase gate.
6. **Safety code before feature code:** All controls, safe words, session caps, and policy checks must be verified before feature logic.
