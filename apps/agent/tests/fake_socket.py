"""A stand-in for Starlette's WebSocket, shaped like the ASGI messages the real one yields.

Only the four methods `chaukanna_agent.transport.WebSocketLike` declares are implemented, which is
the point: if the transport starts needing a fifth, these tests stop compiling rather than quietly
drifting away from the real object.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any


class FakeSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.close_code: int | None = None
        self.sent_json: list[dict[str, Any]] = []
        self.sent_bytes: list[bytes] = []
        self._inbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    # ---- the client side of the socket, driven by the test --------------------------------

    def client_text(self, payload: dict[str, Any]) -> None:
        self._inbound.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def client_raw_text(self, text: str) -> None:
        self._inbound.put_nowait({"type": "websocket.receive", "text": text})

    def client_bytes(self, payload: bytes) -> None:
        self._inbound.put_nowait({"type": "websocket.receive", "bytes": payload})

    def client_disconnect(self) -> None:
        self._inbound.put_nowait({"type": "websocket.disconnect", "code": 1001})

    # ---- the server side, used by the transport --------------------------------------------

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, data: Any) -> None:
        if self.close_code is not None:
            raise ConnectionError("socket closed")
        self.sent_json.append(data)

    async def send_bytes(self, data: bytes) -> None:
        if self.close_code is not None:
            raise ConnectionError("socket closed")
        self.sent_bytes.append(data)

    async def receive(self) -> dict[str, Any]:
        return await self._inbound.get()

    async def close(self, code: int = 1000) -> None:
        self.close_code = code

    # ---- assertions ------------------------------------------------------------------------

    def messages_of(self, type_: str) -> list[dict[str, Any]]:
        return [m for m in self.sent_json if m.get("type") == type_]

    async def wait_for(self, type_: str, timeout: float = 2.0) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            found = self.messages_of(type_)
            if found:
                return found[0]
            await asyncio.sleep(0.01)
        raise AssertionError(f"no {type_!r} frame was sent; got {[m.get('type') for m in self.sent_json]}")
