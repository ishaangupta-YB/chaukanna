# LEARNINGS.md

> Mandatory log: Update at the end of each phase, one paragraph per person. It is judged and you will not remember later.

---

## Phase 0: Foundations

### Member A (Voice Agent & Runtime)
*Agent implementation initialized using uv. Encountered standard setup structure for python-based agents using Bedrock AgentCore. Setting up standard pyproject.toml provides good baseline for the upcoming Phase 2.*

### Member B (Infrastructure, CI/CD, Data)
*Successfully scaffolded CDK infrastructure in TypeScript. Implemented the DynamoDB single-table design with GSI1, S3 artifact bucket with lifecycle rules, and Cognito User Pool. CI/CD pipelines (GitHub Actions) were drafted but require PAT workflow scope for pushing.*

### Member C (Web Frontend & Domain)
*Next.js 15 App Router initialized. Configured FlatCompat for ESLint to handle ESM compatibility with eslint-config-next. The API health route correctly uses standard Next.js route handlers.*

### Member D (Scoring, Pipeline & Integration)
*Initialized the scoring service with uv. Basic pytest smoke tests set up to validate the environment. Added placeholder interfaces for future video integration (Phase 8).*

---

## Phase 1: Domain and Consent

### Member B (Infrastructure, CI/CD, Data)
*Defining the Amplify compute role in CDK instead of the console let it be scoped to the exact table, the `consent/*` prefix and the one signing secret, with a test that fails on any wildcard action, and kept the account id out of the repo. Two Amplify facts cost the most time to find: console environment variables reach the build but not Next.js route handlers at runtime unless `amplify.yml` writes them into `.env.production`, and Amplify rejects any variable starting with `AWS_`, so `AWS_REGION` must come from the SSR runtime itself. Cognito's newer managed login renders nothing until a `ManagedLoginBranding` exists for the client. Deriving the managed login domain prefix from the stack UUID keeps it unique without printing the account id on every login page.*

### Member C (Web Frontend & Domain)
*The consent screen is where an elderly learner meets the product, so the failure paths mattered more than the happy path. An unanswered microphone prompt never resolves `getUserMedia` in some browsers; without a timeout the learner is stranded on a dead screen, so it falls back to typing "हाँ" after 12 seconds and the consent row records which method was used. Safari records `audio/mp4`, not WebM, so the upload key takes its extension from the recorder. Idempotency came from the data model rather than extra checks: the household id is derived from the guardian's Cognito subject so a double tap hits the same key, the consent row is keyed by the timestamp inside the presigned upload key so a replayed post is a no-op, and the invite accept has a ten minute double tap window before the single use hash is gone for good. Cognito tokens are verified with `node:crypto` against the pool JWKS, and the tests forge `alg: none`, HS256, wrong audience and tampered payloads to prove it.*

---

## Phase 2: The Agent, Locally

### Member A (Voice Agent & Runtime)
*Nova 2 Sonic only answers while an audio input stream is open, even for a text turn; our smoke test timed out until it streamed silence alongside the text. The installed Strands SDK (1.56) differed from the phase sketch: the model takes `voice=` and `audio=` directly, and the SDK already reconnects proactively at 420 seconds, below Nova's roughly 8 minute cap, so our job was carrying the stage and red flags into the new connection's prompt through a restart hook. Nova writes the caller transcript sometimes romanized and sometimes in Devanagari, so the tripwire matches numerals in both scripts plus number words in English, romanized Hindi, Devanagari, and English words written in Devanagari, and it carries a run across fragments because recognition splits long numbers. The SDK's bundled terminal display prints raw user transcripts, which would have shown digits before the tripwire could act, so we wrote our own audio-only I/O. Pre-rendering the break character script with the call's own voice failed twice: Nova stops a long verbatim read after two sentences and answers a single short sentence instead of reading it, so per the two strikes rule we stopped and escalated rather than keep tweaking. Replaying ten scripted fixtures through the real `BidiAgent` loop with a stand-in model turned out to be the most valuable test: it exercises the SDK's actual tool executor and reconnect path, not mocks of them.*

---

## Phase 3: The Agent, in the Browser
<!-- To be populated upon completion of Phase 3 -->

---

## Phase 4: Drill Lifecycle
<!-- To be populated upon completion of Phase 4 -->

---

## Phase 5: Scoring and Debrief
<!-- To be populated upon completion of Phase 5 -->

---

## Phase 6: Authorization, Safety, Dashboard
<!-- To be populated upon completion of Phase 6 -->

---

## Phase 7: Demo and Submission
<!-- To be populated upon completion of Phase 7 -->
