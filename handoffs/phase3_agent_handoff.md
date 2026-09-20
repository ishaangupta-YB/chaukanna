# Agent Handoff, Phase 3 (The Agent, in the Browser)

Branch `feat/phase-3-agent-browser`, stacked on `feat/phase-2-agent-local`, which is stacked on
`feat/phase-1-domain-consent`. One line of work; nothing past Phase 0 is on GitHub yet.

Code complete and **verified against the deployed AgentCore Runtime**. A full Hindi drill ran
from a socket to Nova 2 Sonic and back, and persisted. The gate still needs a human on a phone.

## Read these first
- `apps/agent/chaukanna_agent/wire.py` — the whole browser/agent protocol, in one file. Its mirror
  is `apps/web/src/lib/drill-wire.ts`. **Change them together.**
- `apps/agent/chaukanna_agent/transport.py` — the socket as an `AudioSource` and an `AudioSink`.
  `drill.py` does not know this file exists, which is what lets one safety core serve the terminal
  and the browser.
- `apps/agent/chaukanna_agent/store.py` — the claim, and everything a finished drill writes.
- `apps/web/src/lib/drills.ts` — every rule that decides whether a call may happen.
- `apps/web/src/components/learner/useDrillSocket.ts` — the call's whole lifecycle.

## How a call actually connects

Amplify SSR serves requests, not long-lived sockets, so **the browser connects straight to
AgentCore**. A browser also cannot sign a WebSocket handshake, so the route hands it a SigV4
presigned `wss://` URL. Two short-lived things, each useless alone:

1. `wsUrl` — presigned by the compute role, 5 minutes, one AgentCore session id.
2. `token` — the drill session token, sent as the first frame.

The token's signature is not what makes it safe to hand out. The drill row has to be waiting for
exactly its `j` claim, and the agent consumes that in a conditional write. **Verified live:** a
correctly signed, unexpired token for a drill that was already taken gets `drill_unavailable` and
close 1008, with zero audio.

## Verified facts (do not re-derive)

- AgentCore Runtime: port `8080`, WebSocket at `/ws`, health at `/ping`, **ARM64**, host `0.0.0.0`.
  All of that comes from `BedrockAgentCoreApp` except the platform, which the Dockerfile sets.
- Protocol is `HTTP` in `CreateAgentRuntime`. WebSocket is carried *by* the HTTP protocol; there is
  no separate "WEBSOCKET" value. One container serves `/invocations`, `/ws` and `/ping`.
- Limits: 64 KB per frame, **250 frames per second per connection**, 60 minutes per stream. Our
  64 ms chunks are ~16 frames/s each way, so all three are far away.
- AgentCore session ids must be **33 characters or more**.
- The presigned URL: service `bedrock-agentcore`, host `bedrock-agentcore.<region>.amazonaws.com`,
  path `/runtimes/<uri-encoded ARN>/ws`, session id as the query parameter
  `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`. Max expiry 300 s.
- AgentCore is available in **both** `ap-south-1` and `ap-northeast-1`. The runtime is in
  `ap-northeast-1`, next to Nova 2 Sonic.
- `AWS::BedrockAgentCore::Runtime` **does** exist in CloudFormation, so the runtime is CDK
  (`CfnResource`) and not the `agentcore` CLI. There is no L2 construct yet.

## Two bugs that only a real run could find

**1. SigV4 canonical URI is double-encoded.** For `bedrock-agentcore` the canonical request signs
the path encoded a *second* time (`%3A` becomes `%253A`); S3 is the exception that does not.
Getting it wrong is an opaque 403 on the handshake with nothing useful in the message. The payload
hash is the SHA-256 of the empty string, **not** `UNSIGNED-PAYLOAD` — that constant is S3-only.
`aws-sigv4.test.ts` pins both against URLs botocore's own `SigV4QueryAuth` produced.

**2. Python and JavaScript disagree about ISO 8601.** `datetime.now(UTC).isoformat()` gives
`...176154+00:00`; `new Date().toISOString()` gives `...176Z`, and zod's `z.iso.datetime()` rejects
the offset form. The agent wrote a drill row successfully and `GET /api/drills/[id]` then threw on
reading it back — a 500 on the learner's own result page, after a real call. Every agent timestamp
now goes through `chaukanna_agent/clock.py`; `tests/test_clock.py` pins the format.

Both are the kind of thing that passes every unit test and fails in front of a person.

## Decisions worth knowing

- **Only the caller's audio is recorded.** The learner's microphone is never written to disk, S3
  or a log, because the one thing it might contain is the number the tripwire exists to stop.
  `drill/audio/<id>.wav` is caller-only and says so in its S3 metadata.
- S3 prefixes changed: `drill/audio/` expires in 7 days, `drill/transcript/` in 30 (PRD 8.6).
  Lifecycle rules are per prefix, so they cannot share a folder per drill.
- The drill row keeps red flag **ids and positions, never quotes**. A quote is transcript text and
  a guardian may not read a transcript (F7 AC2); it stays in the S3 object.
- **A dropped socket is an `error`, never a `hangup`.** The rubric credits hanging up, and losing
  mobile data must not earn that credit.
- **A drill that never became a call is `cancelled`, not `ended`,** and cancelled drills do not
  count against the one-a-week cap. Found by testing: denying the microphone prompt burned the
  learner's whole week. Fumbling a permission dialog must not cost somebody their practice.
- Re-minting a session token is allowed while the drill is still `session_pending` (each mint
  rotates `j`, killing the previous token), so a learner whose first tap failed can tap again.
- Captions: the learner sees **only their own words**. Caller captions are sent and deliberately
  ignored by the UI — a live transcript of the scammer would give the drill away.
- There is no socket-level reconnect, on purpose. The *model* session is replaced server side
  mid-call and the learner hears nothing; if the *browser's* socket dies the call is over.

## Verified on the deployed system

Runtime `chaukanna_drill-<suffix>` in `ap-northeast-1`, from the image in ECR. Its ARN is a
CDK output; it is not written down here because this repository is public.

- Handshake accepted with a URL signed by our own SigV4 code (~1.4 s).
- `ready` frame carries the real cap and safe word; Nova spoke the S0 courier hook in Hindi
  ("नमस्ते, मैं एक कूरियर सर्विस से बोल रहा हूँ…"), 11 s of caller audio streamed back.
- `hangup` → `clear` → `ended {reason: hangup, finalStage: S0}` → close 1000.
- Persisted: drill row `ended` with `sessionJti` consumed, 9 event rows under `DRILL#<id>`, a valid
  16 kHz mono 16-bit WAV and the redacted transcript in S3.
- `GET /api/drills/[id]` returns 200 with outcomes only, no S3 keys.
- Route refusals: 401 without a learner cookie, 403 cross-origin, 409 `not_ready` on a used drill.
- Replay of a valid token for a used drill: `drill_unavailable`, close 1008, no audio.
- On the page: camera `false`, microphone `true`, secure context, worklet served, and a denied
  microphone shows the Hindi explanation instead of a frozen screen.

## Known gap, not fixed

**First caller audio lands at ~4.2 s from socket open; the PRD asks for 3 s from answer** (F4 AC2),
and the browser also spends time on `getUserMedia`, the token and the worklet before that. Measured
twice, so it is not a cold start. Worth profiling before the demo: the AgentCore session
provisioning and the Nova connect are the two candidates. Nothing about the drill is wrong, it is
just slower than the target.

## To pass the gate

Everything below needs a person and a phone. Nothing else is outstanding.

1. ~~Phase 1 is still unpushed~~ — all three branches are now on GitHub and PR #1 is open. There
   is still **no Amplify app**. See `handoffs/phase1_agent_handoff.md`.
2. Add `AGENT_RUNTIME_ARN` to the Amplify environment variables alongside the Phase 1 five.
   Guardians now sign in with Google, so `chaukanna/google-oauth` must be filled and the stack
   redeployed before anybody can reach `/app` on the deployed URL either.
3. On a real phone on mobile data: take a full Hindi drill, read six digits aloud, and confirm the
   tripwire ends it. Then a second drill and say "roko".
4. Kill the wifi mid-call and confirm the screen explains itself rather than freezing.
5. Two people in different cities, each on their own phone.

## Deploying the agent

```bash
cd apps/agent && uv export --no-dev --no-emit-project --format requirements-txt -o requirements.lock
REPO=<account>.dkr.ecr.ap-northeast-1.amazonaws.com/chaukanna-drill
aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin ${REPO%%/*}
docker build --platform linux/arm64 -t $REPO:$(git rev-parse --short HEAD) .
docker push $REPO:$(git rev-parse --short HEAD)
cd ../../infra && AGENT_IMAGE=$REPO:$(git rev-parse --short HEAD) npx cdk deploy ChaukannaVoiceStack
```

`AGENT_IMAGE` is an environment variable and **never** goes in `cdk.json`: an ECR URI contains the
account id and this repository is public.

## Local testing, the two things that will stop you

- The seeded "Test Dadi" household is owned by `local-e2e-test-sub`, a scripted subject. A real
  Google sign-in gets a different `sub`, so that member is **invisible** on `/app`; create your own
  household and member instead.
- A new member's window defaults to the PRD's Mon-Fri 11:00-18:00 IST, so Ring now is refused with
  `outside_window` at every other hour. Widen the window first.

## Test data left behind

One drill row for the seeded "Test Dadi" member, and that member's window was widened to the whole
of Sunday for testing. Narrow it or delete the row when convenient; neither affects anything else.
