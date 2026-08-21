from __future__ import annotations

from typing import Optional

from ._http import _Transport
from ._models import SandboxData, SandboxNetwork
from ._sandbox import _Sandbox


class _Sandboxes:
    """Account-level collection of persistent Archil sandboxes."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(self, *, disk: object | str | None = None) -> list[_Sandbox]:
        filesystem = disk if isinstance(disk, str) else getattr(disk, "id", None)
        data = await self._transport.request_json("GET", "/api/sandboxes", params={"filesystem": filesystem})
        return [_Sandbox(self._transport, SandboxData.from_json(item)) for item in (data or {}).get("sandboxes") or []]

    async def get(self, id: str) -> _Sandbox:
        data = await self._transport.request_json("GET", f"/api/sandboxes/{id}")
        return _Sandbox(self._transport, SandboxData.from_json(data))

    async def create(
        self,
        *,
        name: Optional[str] = None,
        vcpu_count: Optional[int] = None,
        mem_size_mib: Optional[int] = None,
        base_image: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        max_ttl_seconds: Optional[int] = None,
        max_concurrent_execs: Optional[int] = None,
        network: Optional[SandboxNetwork] = None,
        wait: bool = True,
    ) -> _Sandbox:
        body = {
            key: value
            for key, value in {
                "name": name,
                "vcpu_count": vcpu_count,
                "mem_size_mib": mem_size_mib,
                "base_image": base_image,
                "env": env,
                "max_ttl_seconds": max_ttl_seconds,
                "max_concurrent_execs": max_concurrent_execs,
                "network": network.to_json() if network is not None else None,
            }.items()
            if value is not None
        }
        data = await self._transport.request_json("POST", "/api/sandboxes", params={"wait": wait}, json=body)
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_for_start() if wait else sandbox
