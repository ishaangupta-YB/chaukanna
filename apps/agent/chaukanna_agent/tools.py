"""The four drill tools. Each closes over the session and only mutates it: no I/O, no persistence.

They are async so they run on the event loop, the same thread as the runner that watches the
session. `tripwire` and `end_drill` end the session; the runner then cuts the model's audio, plays
the break character script, and closes the connection. Ending is not left to the model.
"""

from __future__ import annotations

from strands import tool
from strands.types.tools import AgentTool

from .session import DrillSession


def build_tools(session: DrillSession) -> list[AgentTool]:
    @tool(name="advance_stage")
    async def advance_stage(stage: str) -> str:
        """Move the call to the next stage. Call this before each move. Stages go one at a time,
        in order: S1, S2, S3, S4, S5. There is no stage after S5.

        Args:
            stage: The stage you are moving to, for example "S1".
        """
        return session.advance_stage(stage.strip().upper())

    @tool(name="record_red_flag")
    async def record_red_flag(flag_id: str, quote: str) -> str:
        """Record that the person did something a scam victim does.

        Args:
            flag_id: One of stayed_on_call, accepted_secrecy, shared_identifier, agreed_to_move_money,
                accepted_authority.
            quote: A short verbatim quote of what the person said.
        """
        return session.record_red_flag(flag_id.strip(), quote)

    @tool(name="tripwire")
    async def tripwire(kind: str) -> str:
        """Call immediately, in the same turn, if the person speaks six or more digits or starts reading
        out any card, bank, Aadhaar or PAN style identifier. This ends the practice call.

        Args:
            kind: What they started to say: digits, card, aadhaar_like, pan_like, otp.
        """
        return session.model_tripwire(kind)

    @tool(name="end_drill")
    async def end_drill(reason: str) -> str:
        """End the practice call.

        Args:
            reason: safe_word if the person said the safe word, asked if this is real, or sounds
                frightened, confused or unwell. completed when stage S5 is finished.
        """
        return session.model_end(reason.strip().lower())

    return [advance_stage, record_red_flag, tripwire, end_drill]
