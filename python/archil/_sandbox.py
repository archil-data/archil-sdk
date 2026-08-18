from __future__ import annotations

import asyncio
from typing import Optional

from ._http import _Transport
from ._models import (
    SandboxConnection,
    SandboxData,
    SandboxEndpoint,
    SandboxExecData,
    SandboxExecStatus,
    SandboxPlatform,
    SandboxStatus,
)
from ._sandbox_process import _SandboxProcesses
from .errors import SandboxStartError


_POLL_INTERVAL_SECONDS = 0.5


class _SandboxExec:
    def __init__(self, transport: _Transport, data: SandboxExecData) -> None:
        self._transport = transport
        self._data = data

    @property
    def sandbox_id(self) -> str:
        return self._data.sandbox_id

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def command(self) -> str:
        return self._data.command

    @property
    def status(self) -> SandboxExecStatus:
        return self._data.status

    @property
    def exit_code(self) -> Optional[int]:
        return self._data.exit_code

    @property
    def stdout(self) -> Optional[str]:
        return self._data.stdout

    @property
    def stderr(self) -> Optional[str]:
        return self._data.stderr

    @property
    def exit_reason(self) -> Optional[str]:
        return self._data.exit_reason

    @property
    def execute_time_ms(self) -> Optional[int]:
        return self._data.execute_time_ms

    @property
    def started_at(self):
        return self._data.started_at

    @property
    def finished_at(self):
        return self._data.finished_at

    async def refresh(self) -> "_SandboxExec":
        data = await self._transport.request_json("GET", f"/api/sandboxes/{self.sandbox_id}/execs/{self.id}")
        return _SandboxExec(self._transport, SandboxExecData.from_json(data))

    async def cancel(self) -> "_SandboxExec":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.sandbox_id}/execs/{self.id}/cancel")
        return _SandboxExec(self._transport, SandboxExecData.from_json(data))


class _Sandbox:
    def __init__(self, transport: _Transport, data: SandboxData) -> None:
        self._transport = transport
        self._data = data
        self._processes = _SandboxProcesses(transport, data.id)

    def __repr__(self) -> str:
        return f"Sandbox(id={self.id!r}, name={self.name!r}, status={self.status!r})"

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def name(self) -> str:
        return self._data.name

    @property
    def status(self) -> SandboxStatus:
        return self._data.status

    @property
    def vcpu_count(self) -> int:
        return self._data.vcpu_count

    @property
    def mem_size_mib(self) -> int:
        return self._data.mem_size_mib

    @property
    def max_ttl_seconds(self) -> int:
        return self._data.max_ttl_seconds

    @property
    def max_concurrent_execs(self) -> int:
        return self._data.max_concurrent_execs

    @property
    def base_image(self) -> str:
        return self._data.base_image

    @property
    def platform(self) -> Optional[SandboxPlatform]:
        return self._data.platform

    @property
    def endpoints(self) -> list[SandboxEndpoint]:
        return list(self._data.endpoints)

    @property
    def created_at(self):
        return self._data.created_at

    @property
    def running_at(self):
        return self._data.running_at

    @property
    def finished_at(self):
        return self._data.finished_at

    @property
    def last_active_at(self):
        return self._data.last_active_at

    @property
    def expires_at(self):
        return self._data.expires_at

    @property
    def exit_reason(self) -> Optional[str]:
        return self._data.exit_reason

    @property
    def processes(self) -> "_SandboxProcesses":
        return self._processes

    async def refresh(self) -> "_Sandbox":
        data = await self._transport.request_json("GET", f"/api/sandboxes/{self.id}")
        return _Sandbox(self._transport, SandboxData.from_json(data))

    async def _wait_for_start(self) -> "_Sandbox":
        sandbox = self
        while True:
            if sandbox.status == "running":
                return sandbox
            if sandbox.status != "pending":
                raise SandboxStartError(sandbox)
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)
            sandbox = await sandbox.refresh()

    async def _wait_while(self, status: SandboxStatus) -> "_Sandbox":
        sandbox = self
        while sandbox.status == status:
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)
            sandbox = await sandbox.refresh()
        return sandbox

    async def start(self, *, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/start", params={"wait": wait})
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_for_start() if wait else sandbox

    async def stop(self, *, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/stop")
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_while("stopping") if wait else sandbox

    async def pause(self, *, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/pause")
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_while("pausing") if wait else sandbox

    async def resume(self, *, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/resume", params={"wait": wait})
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_for_start() if wait else sandbox

    async def fork(self, *, name: Optional[str] = None, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json(
            "POST",
            f"/api/sandboxes/{self.id}/fork",
            params={"wait": wait},
            json=None if name is None else {"name": name},
        )
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_for_start() if wait else sandbox

    async def create_connection(self) -> SandboxConnection:
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/connections")
        return SandboxConnection.from_json(data)

    async def delete(self) -> None:
        await self._transport.request_empty("DELETE", f"/api/sandboxes/{self.id}")

    async def exec(
        self,
        command: str,
        *,
        command_tty: bool = False,
        env: Optional[dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        wait: bool = True,
    ) -> "_SandboxExec":
        body: dict[str, object] = {"command": command}
        if command_tty:
            body["command_tty"] = True
        if env is not None:
            body["env"] = env
        if timeout_seconds is not None:
            body["timeout_seconds"] = timeout_seconds
        data = await self._transport.request_json(
            "POST",
            f"/api/sandboxes/{self.id}/execs",
            params={"wait": wait},
            json=body,
        )
        result = _SandboxExec(self._transport, SandboxExecData.from_json(data))
        if not wait:
            return result
        while result.status == "running":
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)
            result = await result.refresh()
        return result

    async def list_execs(self) -> list["_SandboxExec"]:
        data = await self._transport.request_json("GET", f"/api/sandboxes/{self.id}/execs")
        return [
            _SandboxExec(self._transport, SandboxExecData.from_json(item)) for item in (data or {}).get("execs") or []
        ]

    async def get_exec(self, exec_id: str) -> "_SandboxExec":
        data = await self._transport.request_json("GET", f"/api/sandboxes/{self.id}/execs/{exec_id}")
        return _SandboxExec(self._transport, SandboxExecData.from_json(data))

    async def cancel_exec(self, exec_id: str) -> "_SandboxExec":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/execs/{exec_id}/cancel")
        return _SandboxExec(self._transport, SandboxExecData.from_json(data))
