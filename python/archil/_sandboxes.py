from __future__ import annotations

from typing import Optional

from ._http import _Transport
from ._models import SandboxData, SandboxMountSpec, SandboxNetwork
from ._sandbox import _Sandbox

# Server-side maximum page size for GET /api/sandboxes.
_SANDBOX_PAGE_LIMIT = 100


class _Sandboxes:
    """Account-level collection of persistent Archil sandboxes."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(
        self,
        *,
        disk: object | str | None = None,
        labels: Optional[dict[str, str]] = None,
        name: Optional[str] = None,
        name_prefix: Optional[str] = None,
    ) -> list[_Sandbox]:
        """List the account's sandboxes that match every filter given: mounting
        ``disk``, carrying each of ``labels``, named ``name``, or with a name
        starting with ``name_prefix``. Follows the server's pages until none
        remain."""
        filesystem = disk if isinstance(disk, str) else getattr(disk, "id", None)
        params = {
            "filesystem": filesystem,
            "label": [f"{key}={value}" for key, value in labels.items()] if labels else None,
            "name": name,
            "name_prefix": name_prefix,
            "limit": _SANDBOX_PAGE_LIMIT,
        }
        sandboxes: list[_Sandbox] = []
        cursor: Optional[str] = None
        while True:
            data, next_cursor = await self._transport.request_json_page(
                "GET", "/api/sandboxes", params={**params, "cursor": cursor}, retry="transient"
            )
            for item in (data or {}).get("sandboxes") or []:
                sandbox = SandboxData.from_json(item)
                # A control plane that predates these filters ignores them.
                if _matches(sandbox, labels, name, name_prefix):
                    sandboxes.append(_Sandbox(self._transport, sandbox))
            if not next_cursor or next_cursor == cursor:
                return sandboxes
            cursor = next_cursor

    async def get(self, id: str) -> _Sandbox:
        data = await self._transport.request_json("GET", f"/api/sandboxes/{id}", retry="transient")
        return _Sandbox(self._transport, SandboxData.from_json(data))

    async def create(
        self,
        *,
        name: Optional[str] = None,
        vcpu_count: Optional[int] = None,
        mem_size_mib: Optional[int] = None,
        base_image: Optional[str] = None,
        image_id: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        max_ttl_seconds: Optional[int] = None,
        idle_ttl_seconds: Optional[int] = None,
        max_concurrent_execs: Optional[int] = None,
        network: Optional[SandboxNetwork] = None,
        ports: Optional[list[int]] = None,
        mounts: Optional[list[SandboxMountSpec]] = None,
        labels: Optional[dict[str, str]] = None,
        wait: bool = True,
    ) -> _Sandbox:
        body = {
            key: value
            for key, value in {
                "name": name,
                "vcpu_count": vcpu_count,
                "mem_size_mib": mem_size_mib,
                "base_image": base_image,
                "image_id": image_id,
                "env": env,
                "max_ttl_seconds": max_ttl_seconds,
                "idle_ttl_seconds": idle_ttl_seconds,
                "max_concurrent_execs": max_concurrent_execs,
                "network": network.to_json() if network is not None else None,
                "ports": ports,
                "mounts": [mount.to_json() for mount in mounts] if mounts is not None else None,
                "labels": labels,
            }.items()
            if value is not None
        }
        data = await self._transport.request_json(
            "POST", "/api/sandboxes", params={"wait": wait}, json=body, retry="connect", retry_throttled=True
        )
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_for_start() if wait else sandbox


def _matches(
    sandbox: SandboxData, labels: Optional[dict[str, str]], name: Optional[str], name_prefix: Optional[str]
) -> bool:
    return (
        all(sandbox.labels.get(key) == value for key, value in (labels or {}).items())
        and (name is None or sandbox.name == name)
        and sandbox.name.startswith(name_prefix or "")
    )
