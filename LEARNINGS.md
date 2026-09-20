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

### Member B (Infrastructure & Lifecycle)
*The rule that shaped this phase is that a schedule firing after a cancellation is normal, not an error, so nothing may be a blind write: every transition is a conditional update naming the state it expects to find, and the ring Lambda re-reads consent, status and window at the moment it fires rather than trusting the decision made hours earlier when the drill was created. That ordering matters in the cancellation path too — the row is marked cancelled first and the EventBridge schedule deleted second, because a process that dies between the two must leave a cancelled drill with a live schedule (harmless, the Lambda re-checks) rather than a live drill with no schedule to stop it. Two things only a deploy would have caught. The window check had to be dropped from the scheduled path: the whole point is scheduling at 10:00 a call that rings at 14:20, and the original guard refused every drill created outside the learner's hours, which would have made the feature usable only during the hours it was meant to arrange. And `lambda.Code.fromAsset` on a source tree installs nothing — the Python 3.12 runtime ships boto3 and botocore and nothing else, so the pydantic model the house style asked for on the event boundary would have imported cleanly in 42 green tests and then failed at cold start in production; twelve lines of explicit validation and a comment explaining why beat a dependency that only breaks where nobody is watching. The email went to the guardian rather than the learner in the end, because the learner deliberately has no account and no address anywhere in this product, and inventing one to send a nudge would have traded a real privacy property for a convenience. A missed drill is evaluated lazily on the next read: a second scheduler whose only job is to tidy a row nobody is looking at is machinery for its own sake at one drill per learner per week. The cheapest verification of the phase turned out to be the least clever one: rather than reason about whether `iam:PassRole` and the `at(...)` timezone expression were right, we created one real throwaway schedule two minutes out and watched it invoke the Lambda by itself, which proves both pitfalls closed in the time it takes to read the IAM policy. The same pass surfaced something no test could have: the two GitHub Actions workflows fire on any push to `main` under `infra/**` or `apps/agent/**` and assume a `chaukanna-github-deploy` role through OIDC, and neither that role nor the IAM OIDC provider has ever been created — so the Phase 0 gate's "CI deploys infra" half has been quietly unmet since day one, and the first merge into `main` will show it as two red runs. Worth knowing before a judge clicks the Actions tab.*

---

## Phase 5: Scoring and Debrief

### Member D (Scoring, Pipeline & Integration)
*Three of this phase's decisions were made for us by the account rather than by design, and finding them cost a read-only API call each instead of a failed deploy. There is no `hi-IN` Polly voice at all — `describe-voices --language-code hi-IN` returns an empty list, and the only Hindi-capable neural voice is `Kajal`, whose `LanguageCode` is `en-IN` with `hi-IN` merely an additional code, so Hindi synthesis is that voice with an explicit `LanguageCode` override. Bedrock Guardrails has no India-specific PII entity: reading the enum out of botocore's own service model rather than trusting memory showed `IN_AADHAAR` and `IN_PAN` simply do not exist, so the one thing this product exists to keep out of a transcript is caught by `regexesConfig` and would otherwise have been caught by nothing. And the judge model cannot be called by its bare id — on-demand throughput is unsupported for Haiku 4.5 in Mumbai and only `global.anthropic.claude-haiku-4-5-...` works, which in turn means the Lambda's IAM has to allow the foundation model with a wildcard region, because a `global.` profile routes across regions and a region-pinned ARN denies it. The deeper lesson was about where judgement belongs. Replaying the ten fixtures against the real model was the cheapest and most valuable hour of the phase, and it caught two scoring errors no unit test could: `shared_identifier` fired on a learner saying her own name and charged her thirty points for it, and `disconnected_early` — the one criterion a learner proves by saying nothing, and so the one with no quote to be held to — was credited for a call that reached stage S4, for a call the agent itself ended on distress, and for a silent timeout where the learner neither spoke nor hung up. The second is the one that mattered: it would have told a frightened woman she did well by hanging up, when she had not hung up, on the worst possible day to get it wrong. The fix was not a better prompt but taking the question away from the model entirely — whether somebody hung up and at which stage are facts already sitting in the transcript, so the credit moved into twelve lines of Python and the prompt now says "do not report this; it is not yours to judge". "Models classify, code counts" turned out to be a rule about which questions you ask at all, not just about who does the arithmetic. Two smaller things earned their keep: writing `{"S": ""}` instead of omitting an attribute meant a blank `language` or `scheduledAt` would fail the web app's strict parse and take down the learner's whole debrief screen over a field the pipeline never had, so absent now means absent; and a failed text-to-speech no longer discards a correct band, because throwing away a real score because Polly broke is a worse outcome than a debrief nobody can listen to.*

### Member C (Web Frontend & Domain)
*The judge demo login is a deliberate authentication bypass, so it was built like one rather than like a convenience: gated on `DEMO_MODE` being exactly the string `on`, a fresh random identity per click so two judges can never share a household or land in a real guardian's data, a signed cookie whose HMAC is derived under its own purpose label so an invite token or a learner session can never be replayed as a demo session, and — the property worth the most — a cookie that is not merely rejected but never even read when demo mode is off, verified by flipping the flag with the same cookie still in the browser and watching the dashboard redirect to Google. The `demo` field on the guardian type is required rather than optional on purpose, so that every place that constructs a guardian has to say which kind it is and a demo one can never be mistaken for a real account by omission. One bug was only findable by actually clicking the button: a top-level form-navigation POST does not carry an `Origin` header in every browser, so the existing same-origin check — written for `fetch`-based JSON posts, where the header is guaranteed — rejected the real browser's own submission with a 403, and the fix was to trust `Sec-Fetch-Site`, which the browser sets and a page cannot forge. Colocating a route test that imported a sibling route's module tangled the dev server's chunk graph and made both routes 500 at runtime while vitest stayed perfectly green, which is a reminder that a passing test suite is evidence about the test environment before it is evidence about the product.*

---

## Phase 6: Authorization, Safety, Dashboard
<!-- To be populated upon completion of Phase 6 -->

---

## Phase 7: Demo and Submission
<!-- To be populated upon completion of Phase 7 -->
