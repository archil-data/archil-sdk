from __future__ import annotations

import asyncio
from typing import Optional, Union

from ._http import _Transport
from ._models import (
    SandboxData,
    SandboxEndpoint,
    SandboxPlatform,
    SandboxProcessOutputHandler,
    SandboxProcessResult,
    SandboxStatus,
    SandboxTerminal,
)
from ._sandbox_process import _SandboxProcesses
from .errors import SandboxStartError
from ._sandbox_files import _SandboxFiles


_POLL_INTERVAL_SECONDS = 0.5


class _Sandbox:
    def __init__(self, transport: _Transport, data: SandboxData) -> None:
        self._transport = transport
        self._data = data
        self._processes = _SandboxProcesses(transport, data.id)
        self._files = _SandboxFiles(self)

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

    @property
    def files(self) -> "_SandboxFiles":
        return self._files

    async def exec(
        self,
        command: str,
        *,
        terminal: Union[bool, SandboxTerminal] = False,
        env: Optional[dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        on_output: Optional[SandboxProcessOutputHandler] = None,
        collect_output: bool = True,
    ) -> SandboxProcessResult:
        process = await self._processes.start(
            command,
            terminal=terminal,
            env=env,
            timeout_seconds=timeout_seconds,
            on_output=on_output,
            collect_output=collect_output,
        )
        return await process.wait()

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

    async def delete(self) -> None:
        await self._transport.request_empty("DELETE", f"/api/sandboxes/{self.id}")
