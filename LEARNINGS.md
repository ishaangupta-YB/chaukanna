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
*Defining the Amplify compute role in CDK instead of the console let it be scoped to the exact table, the `consent/*` prefix and the one signing secret, with a test that fails on any wildcard action, and kept the account id out of the repo. Two Amplify facts cost the most time to find: console environment variables reach the build but not Next.js route handlers at runtime unless `amplify.yml` writes them into `.env.production`, and Amplify rejects any variable starting with `AWS_`, so `AWS_REGION` must come from the SSR runtime itself. Cognito's newer managed login renders nothing until a `ManagedLoginBranding` exists for the client. Deriving the managed login domain prefix from the stack UUID keeps it unique without printing the account id on every login page. Two things were tightened after the first pass: the artifacts bucket accepted a presigned PUT from any origin with any header, which is now the app origins and `content-type`, the only header the upload actually sends; and `amplify.yml` now derives `APP_URL` from the `AWS_APP_ID` and `AWS_BRANCH` variables Amplify provides to the build, which removes the chicken and egg where the first build needs a URL that does not exist until the app is created. A repository is only as private as its worst `git add`, so `scripts/check-staged.sh` runs as a pre-commit hook and refuses private docs, environment files, key material, local drill recordings, a template filled with real ids, and any source file `.gitignore` silently swallows.*

### Member C (Web Frontend & Domain)
*The consent screen is where an elderly learner meets the product, so the failure paths mattered more than the happy path. An unanswered microphone prompt never resolves `getUserMedia` in some browsers; without a timeout the learner is stranded on a dead screen, so it falls back to typing "हाँ" after 12 seconds and the consent row records which method was used. Safari records `audio/mp4`, not WebM, so the upload key takes its extension from the recorder. Idempotency came from the data model rather than extra checks: the household id is derived from the guardian's Cognito subject so a double tap hits the same key, the consent row is keyed by the timestamp inside the presigned upload key so a replayed post is a no-op, and the invite accept has a ten minute double tap window before the single use hash is gone for good. Cognito tokens are verified with `node:crypto` against the pool JWKS, and the tests forge `alg: none`, HS256, wrong audience and tampered payloads to prove it. Product rules are worth enforcing where the browser can see them, not only in review: a `Permissions-Policy` header now denies the camera on every response, which is rule 7 made mechanical, grants the microphone to our own origin only, denies framing so no page can wrap the consent button or the kill switch, and sends no referrer because an invite token lives in the URL path.*

---

## Phase 2: The Agent, Locally

### Member A (Voice Agent & Runtime)
*Nova 2 Sonic only answers while an audio input stream is open, even for a text turn; our smoke test timed out until it streamed silence alongside the text. The installed Strands SDK (1.56) differed from the phase sketch: the model takes `voice=` and `audio=` directly, and the SDK already reconnects proactively at 420 seconds, below Nova's roughly 8 minute cap, so our job was carrying the stage and red flags into the new connection's prompt through a restart hook. Nova writes the caller transcript sometimes romanized and sometimes in Devanagari, so the tripwire matches numerals in both scripts plus number words in English, romanized Hindi, Devanagari, and English words written in Devanagari, and it carries a run across fragments because recognition splits long numbers. The SDK's bundled terminal display prints raw user transcripts, which would have shown digits before the tripwire could act, so we wrote our own audio-only I/O. Pre-rendering the break character script with the call's own voice failed twice: Nova stops a long verbatim read after two sentences and answers a single short sentence instead of reading it, so per the two strikes rule we stopped and escalated rather than keep tweaking; the call is to ship the phase without it, with the CLI refusing to run unless `--allow-missing-break-audio` says the silence is deliberate. Replaying ten scripted fixtures through the real `BidiAgent` loop with a stand-in model turned out to be the most valuable test: it exercises the SDK's actual tool executor and reconnect path, not mocks of them.*

---

## Phase 3: The Agent, in the Browser

### Member A (Voice Agent & Runtime)
*Amplify SSR serves requests, not long-lived sockets, so the browser connects straight to AgentCore and the route handler's job is to hand it a SigV4 presigned `wss://` URL, because a browser cannot sign a handshake either. Writing that presigner by hand rather than adding three dependencies paid off twice over: for `bedrock-agentcore` the canonical request signs the path encoded a second time, so `%3A` becomes `%253A`, and the payload hash is the SHA-256 of the empty string rather than the `UNSIGNED-PAYLOAD` constant that only S3 uses. Both mistakes surface as a bare 403 on the handshake with nothing in the message, so we pinned the output byte for byte against URLs botocore's own signer produced. Keeping the transport behind the same `AudioSource` and `AudioSink` interfaces the terminal already used meant `drill.py` needed no changes at all, and the whole safety core — tripwire, safe word, cap, stage machine — reached the browser untouched. The two bugs worth the trip were only findable by running the real thing: Python's `isoformat()` emits an offset where JavaScript emits `Z`, so the agent wrote a drill row successfully and the learner's own result page then threw a 500 reading it back; and denying the microphone prompt marked the drill ended, which burned the learner's one practice call for the week over a permission dialog. A drill that never became a call is now cancelled rather than ended, and cancelled drills do not count against the cap. Recording only the caller's half of the audio was the easy call: the learner's microphone is the one place a real Aadhaar number could survive the tripwire, and nothing in the MVP needs it.*

---

## Auth revision: Google sign-in (spans Phase 1)

### Member C (Web Frontend & Domain)
*Replacing email-and-password sign-up with Google turned out to be a stack question rather than an
auth question: CLAUDE.md pins Cognito managed login and forbids adding an auth library, and Google
SSO is an identity provider on the pool we already had, not a second auth stack, so PKCE, the JWKS
verification and the household id derived from the Cognito subject needed no changes at all. Better
Auth would have been the expensive answer to a question we were not asking, because it wants to own
sessions and a users table and this app deliberately has neither. What actually removes the password
is dropping `COGNITO` from the client's supported identity providers; leaving it there and simply not
linking to it would have left a working password form one URL away, so the test asserts the rendered
list is exactly `['Google']` and that `ExplicitAuthFlows` is absent. Two Secrets Manager traps cost
real time. `Secret.fromSecretNameV2(...).secretValue` builds a full ARN from the *synthesising*
environment's region, so a synth without a profile quietly produced a `us-east-1` ARN for a secret
living in Mumbai; `SecretValue.secretsManager(name, { jsonField })` emits the bare name and is right
wherever it runs. And a CloudFormation dynamic reference resolves at deploy time, not at run time,
which means rotating the Google client secret does nothing at all until the stack is deployed again
— the opposite of the runtime-secret intuition every other secret in this repo trains you to have.
The last lesson was not code: a push kept being rejected for a missing `workflow` scope while the
token demonstrably had it, because a repo-local `credential.helper=osxkeychain` was serving an older
cached token and `GIT_ASKPASS` is only consulted when the helper has nothing to say.*

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
