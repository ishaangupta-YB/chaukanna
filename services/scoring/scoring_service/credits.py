"""The credits the code computes rather than the model.

`disconnected_early` is the only one, and it is here because replaying the ten fixtures against
the real judge showed the model cannot be trusted with it — not through any fault of the prompt,
but because it is the one criterion a learner proves by *saying nothing*. With no quote to hold
it to, `score.judge.v1` credited it for a drill that reached stage S4, for a drill the agent
ended on distress, and for a timeout in which the learner never spoke or hung up at all.

Two of those are actively harmful. A learner who froze, or who was so frightened that the agent
broke character to stop the call, would have been told she did well by hanging up. She did not
hang up. The debrief would have praised her for something that did not happen, on the worst day
to get it wrong.

Whether the learner hung up, and at which stage, are already facts in the transcript. So this is
counting, not judging, and the phase file's rule applies: models classify, code counts.
"""

from __future__ import annotations

from .transcript import Transcript

CREDIT_ID = "disconnected_early"

#: The learner's own hang up. Every other end reason is the system stopping the drill (`tripwire`,
#: `safe_word`, `distress`, `is_this_real`), the drill running out (`timeout`, `completed`,
#: `model_ended`) or a failure (`error`). Only one of them is the learner putting the phone down.
LEARNER_HANGUP = "hangup"

#: "before stage S3" (PRD section 9, and `score.judge.v1`'s own wording). S3 is ISOLATION, the
#: point at which the call has become a thing the learner is keeping secret. Reaching S3 is
#: exactly what the credit is for not doing, so S3 itself does not earn it.
EARLY_STAGES = ("S0", "S1", "S2")


def disconnected_early(transcript: Transcript) -> dict[str, object]:
    """The `disconnected_early` credit entry, decided from the transcript alone.

    Evidence is a factual note rather than a quote, because there is nothing to quote: the whole
    point is that the learner stopped talking to the caller. The debrief screen must not render
    it inside quotation marks.
    """
    hung_up = transcript.endReason == LEARNER_HANGUP
    early = transcript.finalStage in EARLY_STAGES
    if hung_up and early:
        return {
            "fired": True,
            "evidence": f"ended the call at stage {transcript.finalStage}",
            "computed": True,
        }
    return {"fired": False, "evidence": "", "computed": True}
