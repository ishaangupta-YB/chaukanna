# Agent Handoff, Phase 2 (The Agent, Locally)

Branch `feat/phase-2-agent-local` (stacked on the Phase 1 branch). The safety core, runner, CLI and fixture suite are done and green (`cd apps/agent && uv run pytest`: 90 passed, 3 skipped). The gate still needs **a human voice run** and **the break character audio** (a decision is pending, see below).

## Read these first
- `chaukanna_agent/drill.py`, the runner. It owns the call lifecycle and the order of authority: transport checks, then the cap timer, then the model's tools.
- `chaukanna_agent/tripwire.py` and `safety.py`: the transport tripwire, stop phrases, and caller limit monitor.
- `chaukanna_agent/session.py`: the stage machine, end reasons, event log, `DrillRecord` (the persistence and scoring contract).
- `tests/test_fixture_replay.py` and `tests/scripted_model.py`: fixtures replayed through the **real** `BidiAgent` loop.

## Verified facts about the SDK and model (do not re-derive)
- `strands-agents[bidi]` 1.56: `BedrockNovaSonicModel(boto_session=, model_id=, voice=, audio={"input":{"sample_rate"},"output":{...}}, connection={"restart_after_s"})`. The phase doc's `provider_config=` sketch is wrong for this version.
- Nova 2 Sonic answers **only while an audio input stream is open**, even for text turns. The runner always pumps the mic, or silence.
- The SDK reconnects proactively at `restart_after_s` (default 420, Nova's cap is about 8 min) and reactively on Nova's 175 s silence timeout. `build_agent` hooks `BidiBeforeConnectionRestartEvent` to append `session.state_note()` (stage and flags) to the prompt. Test the path by lowering `MODEL_RESTART_AFTER_SECONDS`.
- Voices for hi-IN and en-IN: `kiara` (feminine) and `arjun` (masculine). The scenario uses `arjun` for both, because the persona and break script use masculine Hindi verb forms ("baat kar raha hoon", "batata hoon"). The phase sketch had `kiara` for Hindi.
- Nova writes transcripts sometimes romanized and sometimes in Devanagari. The tripwire covers both.
- The SDK's `BidiAudioIO` renders raw user transcripts to the terminal, so we don't use it; `audio.py` is our audio-only I/O (sounddevice, which bundles PortAudio).

## Prompts
`docs/AGENT_PROMPTS.md` is the source. `scripts/sync_prompts.py` copies blocks into `chaukanna_agent/prompts/`, and `tests/test_prompts.py` fails on drift. Two prompts were added to the doc: `drill.kickoff.v1` (the first turn cue, since the caller speaks first) and `render.verbatim_reader.v1` (build time only).

## Pending decision: break character audio (two strikes, stopped)
`drill.break_character.v1` must play word for word, even mid sentence. Pre-rendering it with Nova `arjun` failed twice: a long read stops after 2 sentences, and a single short sentence gets answered instead of read. `scripts/render_break_character.py` is **uncommitted** until the user picks a fallback. Until then the CLI refuses to run without the audio unless you pass `--allow-missing-break-audio`, in which case the drill still ends on time but silently.

## Tripwire classifier
PRD section 8.2 also mentions a small classifier (`tripwire.classifier.v1`). It is not a Phase 2 task, so it was not built. Ask before adding it.

## Observed once in a real rehearsal
The caller's S4 line tripped the caller limit monitor for a number run. It was stored `[redacted]` and logged as `caller_limit_violation`, and two reruns were clean. This is a possible persona slip on hard limit 2. Fix it with a versioned prompt change plus a fixture rerun, not now.

## To pass the gate
1. Resolve the break character audio.
2. `AWS_PROFILE=chaukanna VOICE_REGION=ap-northeast-1 uv run python -m chaukanna_agent.local --language hi-IN` with headphones: go along to S3, read six digits aloud (the drill should break character within the turn), then run again and say "roko". Save the runs with `--out ../../fixtures/recorded/<name>.json`, then run `uv run pytest`.
