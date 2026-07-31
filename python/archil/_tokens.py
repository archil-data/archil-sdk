from __future__ import annotations

from typing import Optional

from ._http import _Transport
from ._models import ApiTokenResponse


class _Tokens:
    """Account-level API keys (the control-plane credentials), distinct from
    per-disk mount tokens.

    Every method is available both synchronously and asynchronously — call it
    directly to block, or use ``.aio`` for a coroutine
    (e.g. ``await archil.tokens.list.aio()``)."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(
        self, *, limit: Optional[int] = None, cursor: Optional[str] = None
    ) -> list[ApiTokenResponse]:
        data = await self._transport.request_json(
            "GET", "/api/tokens", params={"limit": limit, "cursor": cursor}
        )
        # `or []` (not get's default) so a Go backend serializing an empty/nil
        # slice as JSON `null` is treated as empty, not iterated into a TypeError.
        return [ApiTokenResponse.from_json(t) for t in (data or {}).get("tokens") or []]

    async def create(self, *, name: str, description: Optional[str] = None) -> ApiTokenResponse:
        body: dict = {"name": name}
        if description is not None:
            body["description"] = description
        data = await self._transport.request_json("POST", "/api/tokens", json=body)
        return ApiTokenResponse.from_json(data)

    async def delete(self, id: str) -> None:
        await self._transport.request_empty("DELETE", f"/api/tokens/{id}")
