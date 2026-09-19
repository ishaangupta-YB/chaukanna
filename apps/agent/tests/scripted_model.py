"""A BidiModel that replays a fixture script through the real BidiAgent loop and DrillRunner.

It stands in for Nova Sonic only: tool calls go through the SDK's tool executor, reconnects through
the SDK's restart path, and every learner fragment through the runner's transport tripwire.

Steps, in order:
  {"caller": "text", "tools": [{"name": "advance_stage", "input": {"stage": "S1"}}]}
  {"learner": "text" | ["fragment", "fragment"]}   one turn, optionally split like ASR does
  {"pause": 0.2}                                    seconds of nothing
  {"hangup": true}                                  the learner ends the call
  {"model_timeout": true}                           the connection times out, the SDK reconnects
After the last step the model waits, as a live call does, until the session ends.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from collections.abc import AsyncGenerator, Callable
from typing import Any

from strands.experimental.bidi import (
    BidiAudioStreamEvent,
    BidiConnectionStartEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    ToolResultEvent,
    ToolUseStreamEvent,
)
from strands.experimental.bidi.models import BidiModel, BidiModelTimeoutError

from chaukanna_agent.audio import silence

TOOL_RESULT_TIMEOUT = 2.0
CALLER_AUDIO = base64.b64encode(silence(0.05)).decode("ascii")


class ScriptedModel(BidiModel):
    def __init__(self, steps: list[dict[str, Any]], hangup: Callable[[], None] | None = None) -> None:
        self._steps = steps
        self._index = 0
        self._hangup = hangup
        self._config: dict[str, Any] = {"model_id": "scripted", "connection": {}}
        self.usage_is_cumulative = False
        self.system_prompts: list[str] = []
        self.tool_names: list[str] = []
        self.tool_results: dict[str, str] = {}
        self._pending: dict[str, asyncio.Future[str]] = {}
        self._closed = asyncio.Event()

    # config
    def get_config(self) -> dict[str, Any]:  # type: ignore[override]
        return self._config

    def update_config(self, **model_config: Any) -> None:
        self._config.update(model_config)

    # lifecycle
    async def start(self, system_prompt: str | None = None, tools: Any = None, messages: Any = None, **_: Any) -> None:
        self.system_prompts.append(system_prompt or "")
        self.tool_names = [t["name"] for t in tools or []]
        self._closed = asyncio.Event()

    async def stop(self) -> None:
        self._closed.set()
        for future in self._pending.values():
            if not future.done():
                future.cancel()

    async def send(self, content: Any) -> None:
        if isinstance(content, ToolResultEvent):
            result = content.tool_result
            text = " ".join(block.get("text", "") for block in result.get("content", []))
            self.tool_results[result["toolUseId"]] = text
            future = self._pending.get(result["toolUseId"])
            if future and not future.done():
                future.set_result(text)

    async def receive(self) -> AsyncGenerator[Any, None]:
        yield BidiConnectionStartEvent(connection_id="scripted", model="scripted")
        while self._index < len(self._steps) and not self._closed.is_set():
            step = self._steps[self._index]
            self._index += 1
            async for event in self._play(step):
                yield event
        await self._closed.wait()

    async def _play(self, step: dict[str, Any]) -> AsyncGenerator[Any, None]:
        if "caller" in step:
            for call in step.get("tools", []):
                tool_use_id = str(uuid.uuid4())
                future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
                self._pending[tool_use_id] = future
                current = {"toolUseId": tool_use_id, "name": call["name"], "input": call.get("input", {})}
                yield ToolUseStreamEvent(
                    delta={
                        "toolUse": {
                            "toolUseId": tool_use_id,
                            "name": call["name"],
                            "input": json.dumps(call.get("input", {})),
                        }
                    },  # type: ignore[typeddict-item]
                    current_tool_use=current,
                )
                try:
                    await asyncio.wait_for(future, TOOL_RESULT_TIMEOUT)
                except (TimeoutError, asyncio.CancelledError):
                    return
            text = step.get("caller") or ""
            if text:
                response_id = str(uuid.uuid4())
                yield BidiResponseStartEvent(response_id=response_id)
                yield BidiTranscriptStreamEvent(delta=text, role="assistant")
                yield BidiAudioStreamEvent(audio=CALLER_AUDIO, format="pcm", sample_rate=16000, channels=1)
                yield BidiTranscriptCompleteEvent(transcript=text, role="assistant")
                yield BidiResponseCompleteEvent(response_id=response_id, stop_reason="complete")
        elif "learner" in step:
            fragments = step["learner"] if isinstance(step["learner"], list) else [step["learner"]]
            for fragment in fragments:
                yield BidiTranscriptStreamEvent(delta=fragment, role="user")
                await asyncio.sleep(0)
            yield BidiTranscriptCompleteEvent(transcript=" ".join(fragments), role="user")
        elif "pause" in step:
            await asyncio.sleep(float(step["pause"]))
        elif step.get("hangup") and self._hangup:
            self._hangup()
        elif step.get("model_timeout"):
            raise BidiModelTimeoutError("scripted connection timeout")
