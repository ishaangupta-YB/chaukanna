# Agent Handoff, Phase 5 (Scoring and debrief)

Branch `feat/phase-3-agent-browser`. Code complete, every suite green, **nothing deployed**:
`ChaukannaStack` still has no scoring resources in the account, and the state machine, the
guardrail and the five Lambdas exist only as a clean `cdk diff`.

## Read these first
- `services/scoring/scoring_service/credits.py` — the shortest file in the phase and the one that
  explains the most. It is why the judge prompt is v2.
- `services/scoring/scoring_service/judge.py` — strict parsing, one retry, and the two places code
  overrules the model.
- `services/scoring/scoring_service/rubric.py` — a test parses PRD section 9 and fails if the
  weights in code ever drift from the document.
- `infra/lib/chaukanna-stack.ts` sections 13 to 17.
- `apps/web/src/lib/debrief.ts` — the four screen states, including the two failure ones.

## The shape of it

```
agent ends the call, writes drill/transcript/<id>.json, drill row -> ended
  → states:StartExecution  name drill-<drillId>   (ap-south-1, from ap-northeast-1)
       ↓
  redact   guardrail, line by line  → drill/redacted/<id>.json
  judge    score.judge.v2           → flags, credits, turning point   (retry once, then fail)
  score    pure function, no model  → score + band
  debrief  debrief.writer.v1 + Polly Kajal → debrief/<id>.mp3
  finish   SCORE row + drill ended -> scored, conditional      → learner's screen polls and fills
```

Failure routing: redact / judge / score → `score_failed`, generic debrief, **never a guessed
number**. Debrief alone → still `scored`, band kept, no audio.

## Decisions worth knowing

- **`disconnected_early` is computed in code, not judged.** Against the real model it fired for a
  stage S4 call, for a call the agent ended on distress, and for a silent timeout. Two of those
  would have congratulated a learner for hanging up when she did not hang up. `finalStage` and
  `endReason` are already facts in the transcript, so it is a stage comparison, not a judgement.
  The prompt now explicitly tells the model not to report it.
- **`score.judge.v2`** also narrows `shared_identifier` to an actual *number*. Under v1 it fired on
  a learner saying her own name and cost her 30 points in three of ten fixtures.
- **`stayed_on_call` never fires against the real model** and was deliberately left alone. No
  caller line in any fixture tells the learner not to disconnect, so the non-fire is honest.
  Making it fire would have dropped `code_switcher` — a learner who said she would call her son
  and named 1930 — into `at_risk`, which is a worse error than the one it would fix.
- **A blank attribute is never written.** `finish.py` omits an empty field rather than writing
  `{"S": ""}`, because the web app parses the score row strictly and a blank `language` or
  `scheduledAt` fails validation and takes the whole debrief screen down.
- **The score row's `redactedKey` is deliberately not declared in the web app's zod schema**, so
  it is stripped on read and the key to a transcript can never reach a page or a browser.
- **No pydantic anywhere in `scoring_service`.** `Code.fromAsset` installs nothing; there is a test
  that walks the AST of every runtime module and fails on an import outside stdlib and boto3.
- **Guardrail version is `DRAFT`**, on purpose: it is defined in CDK, so DRAFT always reflects what
  was deployed and there is no published version anyone can forget to bump.

## Verified
- scoring 243, web 205, agent 193 + 3 skipped, lifecycle 42, infra 58. **741 tests.**
  Typecheck, lint, ruff, production build, `cdk synth` on both stacks.
- **All ten fixtures scored against the real model** (`global.anthropic.claude-haiku-4-5-...`,
  `ap-south-1`), every one parsed on the first attempt, and the run was repeated with identical
  bands. Recorded in `fixtures/judge/` and replayed offline by `tests/test_recorded_judge.py`.
  Regenerate with `scripts/record_judge.py` whenever the judge prompt changes.

| fixture | band | score | | fixture | band | score |
|---|---|---|---|---|---|---|
| compliant | **at_risk** | 0 | | immediate_hangup | **safe** | 80 |
| digit_sharer | at_risk | 0 | | polite_refusal | safe | 80 |
| safe_word_s4 | at_risk | 20 | | code_switcher | safe | 90 |
| timeout | at_risk | 20 | | distressed | wobbly | 40 |
| safe_word_s1 | wobbly | 50 | | silence | wobbly | 50 |

  The two the phase file names are the two it demands. All three bands are populated, which is
  what the demo needs.
- Polly checked live: `Kajal` / `neural` / `hi-IN` returns mp3, and so does the same voice at
  `en-IN`. There is no `hi-IN` voice to use instead.
- `ApplyGuardrail`'s request and response shape checked against botocore's service model.

## Not verified, and it needs a deploy
1. **The guardrail has never been called.** None exists in the account yet. `redact.py` is tested
   against the confirmed API shape only. The first real `apply_guardrail` happens after
   `cdk deploy ChaukannaStack`.
2. **The state machine has never run.** No execution has ever been started.
3. **The gate**: a real drill producing a spoken debrief within 60 seconds. That needs Phase 3's
   gate first, which needs a phone, which needs a deployed URL, which needs an Amplify app.

## Deploying this, in order, and one real hazard

```bash
cd infra && AWS_PROFILE=chaukanna npx cdk deploy ChaukannaStack        # guardrail, lambdas, SFN
export AGENT_IMAGE=810225483947.dkr.ecr.ap-northeast-1.amazonaws.com/chaukanna-drill:clockfix-134839
AWS_PROFILE=chaukanna npx cdk deploy ChaukannaVoiceStack               # env var + StartExecution
```

**`cdk deploy ChaukannaVoiceStack` without `AGENT_IMAGE` set will destroy the live AgentCore
runtime.** `chaukanna_drill` is deployed and READY; `bin/infra.ts` only creates the runtime when
an image is given, so a synth without one removes it. Pre-existing since Phase 3, but Phase 5 is
the first change that forces a voice-stack redeploy. Worth making `bin/infra.ts` refuse.

Then, against the deployed guardrail:

```bash
cd services/scoring
AWS_PROFILE=chaukanna uv run python -m scoring_service.cli \
  --transcript ../../fixtures/transcripts/compliant.json --no-dry-run
AWS_PROFILE=chaukanna aws stepfunctions list-executions \
  --state-machine-arn <ScoringStateMachineArn> --region ap-south-1 --max-results 5
```

## Still open, inherited
- No Amplify app, so no deployed URL. Everything a human has to judge waits on it.
- CI cannot deploy: the `chaukanna-github-deploy` role and the OIDC provider still do not exist.
  The workflows now **skip cleanly** instead of failing red, and `scripts/setup-github-oidc.sh`
  will create them, but it refuses to run without an explicit confirmation because it mints a
  role that can deploy the whole account.
- First caller audio at ~4.2 s against the PRD's 3 s (F4 AC2), untouched since Phase 3.
