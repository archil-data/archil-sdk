from __future__ import annotations

import asyncio
import contextlib
import json
from typing import AsyncIterator, Optional, Union

import httpx
from websockets.asyncio.client import ClientConnection, connect as _websocket_connect
from websockets.exceptions import WebSocketException

from ._http import _MAX_RETRIES, _Transport, _retry_delay
from ._models import (
    SandboxData,
    SandboxEndpoint,
    SandboxPortToken,
    CreatedSandboxPortToken,
    SandboxPortTokenPage,
    SandboxNetwork,
    SandboxPlatform,
    SandboxProcessOutputHandler,
    SandboxProcessResult,
    SandboxStatus,
    SandboxTerminal,
)
from ._sandbox_process import _SandboxProcess
from .errors import SandboxStartError, SandboxPauseError
from ._sandbox_files import _SandboxFiles


_POLL_INTERVAL_SECONDS = 0.5


class _Sandbox:
    def __init__(self, transport: _Transport, data: SandboxData) -> None:
        self._transport = transport
        self._data = data
        self._processes = _SandboxProcesses(self)
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
    def idle_ttl_seconds(self) -> int:
        return self._data.idle_ttl_seconds

    @property
    def checkpoint(self) -> Optional[str]:
        return self._data.checkpoint

    @property
    def max_concurrent_execs(self) -> int:
        return self._data.max_concurrent_execs

    @property
    def base_image(self) -> str:
        return self._data.base_image

    @property
    def image_digest(self) -> Optional[str]:
        return self._data.image_digest

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
    def exit_reason(self) -> Optional[str]:
        return self._data.exit_reason

    @property
    def processes(self) -> "_SandboxProcesses":
        """Deprecated: use run() and attach(); removed in the next version."""
        return self._processes

    @property
    def files(self) -> "_SandboxFiles":
        return self._files

    async def run(
        self,
        command: str,
        *,
        cwd: Optional[str] = None,
        terminal: Union[bool, SandboxTerminal] = False,
        env: Optional[dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        on_output: Optional[SandboxProcessOutputHandler] = None,
        collect_output: bool = True,
    ) -> "_SandboxProcess":
        """Start a process and return its handle without waiting for exit."""
        process = _SandboxProcess("", 0, on_output, collect_output, self._new_process_connection, self._control_process)
        terminal_request: Union[bool, dict[str, int]]
        if isinstance(terminal, SandboxTerminal):
            terminal_request = {"cols": terminal.cols, "rows": terminal.rows}
        else:
            terminal_request = terminal
        request: dict[str, object] = {
            "type": "start",
            "command": command,
            "terminal": terminal_request,
            "env": env or {},
        }
        if cwd is not None:
            request["cwd"] = cwd
        if timeout_seconds is not None:
            request["timeout_seconds"] = timeout_seconds
        await process._connect(request, "started")
        return process

    async def attach(
        self,
        process_id: str,
        *,
        offset: int = 0,
        on_output: Optional[SandboxProcessOutputHandler] = None,
        collect_output: bool = True,
    ) -> "_SandboxProcess":
        """Reattach to a process, optionally resuming output from a cursor."""
        process = _SandboxProcess(
            process_id,
            offset,
            on_output,
            collect_output,
            self._new_process_connection,
            self._control_process,
        )
        await process._connect(
            {"type": "attach", "process_id": process_id, "offset": offset},
            "attached",
        )
        return process

    async def _new_process_connection(self) -> ClientConnection:
        attempt = 0
        while True:
            try:
                data = await self._transport.request_json(
                    "POST",
                    f"/api/sandboxes/{self.id}/connections",
                    retry="transient",
                )
                return await _websocket_connect(data["url"])
            except httpx.TransportError as exc:
                raise ConnectionError("Process connection failed") from exc
            except (OSError, WebSocketException) as exc:
                if attempt >= _MAX_RETRIES:
                    raise ConnectionError(f"Process connection failed after {attempt + 1} attempts") from exc
            await asyncio.sleep(_retry_delay(attempt))
            attempt += 1

    async def _control_process(self, request: dict[str, object]) -> None:
        socket = await self._new_process_connection()
        try:
            await socket.send(json.dumps(request, separators=(",", ":")))
            response = await socket.recv()
            if not isinstance(response, str):
                raise RuntimeError(f"Invalid process {request['type']} response")
            event = json.loads(response)
            if event.get("type") == "error":
                raise RuntimeError(f"{event['error']}: {event['message']}")
            expected = "killed" if request["type"] == "kill" else "resized"
            if event != {"type": expected}:
                raise RuntimeError(f"Invalid process {request['type']} response")
        finally:
            await socket.close()

    async def exec(
        self,
        command: str,
        *,
        cwd: Optional[str] = None,
        terminal: Union[bool, SandboxTerminal] = False,
        env: Optional[dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        on_output: Optional[SandboxProcessOutputHandler] = None,
        collect_output: bool = True,
    ) -> SandboxProcessResult:
        process = await self.run(
            command,
            cwd=cwd,
            terminal=terminal,
            env=env,
            timeout_seconds=timeout_seconds,
            on_output=on_output,
            collect_output=collect_output,
        )
        return await process.wait()

    async def refresh(self) -> "_Sandbox":
        data = await self._transport.request_json("GET", f"/api/sandboxes/{self.id}", retry="transient")
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
        data = await self._transport.request_json(
            "POST", f"/api/sandboxes/{self.id}/start", params={"wait": wait}, retry="transient"
        )
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_for_start() if wait else sandbox

    async def stop(self, *, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/stop", retry="transient")
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_while("stopping") if wait else sandbox

    async def pause(self, *, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json("POST", f"/api/sandboxes/{self.id}/pause", retry="transient")
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        if not wait:
            return sandbox
        sandbox = await sandbox._wait_while("pausing")
        if sandbox.status != "paused":
            raise SandboxPauseError(sandbox)
        return sandbox

    async def resume(self, *, wait: bool = True) -> "_Sandbox":
        data = await self._transport.request_json(
            "POST", f"/api/sandboxes/{self.id}/resume", params={"wait": wait}, retry="transient"
        )
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        return await sandbox._wait_for_start() if wait else sandbox

    async def fork(self, *, name: Optional[str] = None, wait: bool = True) -> "_Sandbox":
        """Fork this sandbox's current state. A running sandbox is paused for the
        snapshot and resumed once the fork is accepted; a paused or stopped
        sandbox is left as it is. The fork names the checkpoint the pause
        returned, so it does not depend on the source still being paused when
        the request lands. Resuming the source is best effort: the child is
        returned even if the source could not be resumed, and this sandbox is
        updated in place with the source's state after the fork."""
        # Pause is idempotent: "pausing" means the sandbox was live and is ours
        # to resume; "paused" or "stopped" means it was already inactive.
        source = await self.pause(wait=False)
        resume_after_fork = source.status == "pausing"
        checkpoint = source.checkpoint
        body = {key: value for key, value in {"name": name, "checkpoint": checkpoint}.items() if value is not None}
        try:
            source = await source._wait_while("pausing")
            data = await self._transport.request_json(
                "POST",
                f"/api/sandboxes/{self.id}/fork",
                # A source we paused resumes as soon as the fork is accepted, not after the child boots.
                params={"wait": wait and not resume_after_fork},
                json=body or None,
                retry="connect",
            )
        finally:
            if resume_after_fork:
                with contextlib.suppress(Exception):
                    source = await self.resume(wait=False)
            self._data = source._data
        sandbox = _Sandbox(self._transport, SandboxData.from_json(data))
        if not wait:
            return sandbox
        sandbox = await sandbox._wait_for_start()
        if resume_after_fork:
            with contextlib.suppress(Exception):
                self._data = (await source._wait_while("pending"))._data
        return sandbox

    async def expose_port(self, port: int) -> str:
        """Expose a TCP port publicly (1–65535), returning its hostname."""
        data = await self._transport.request_json(
            "PUT", f"/api/sandboxes/{self.id}/ports/{port}", retry="transient"
        )
        return data["hostname"]

    async def list_ports(self) -> list[SandboxEndpoint]:
        """List explicitly exposed public ports. Service-published ports are in ``endpoints``."""
        data = await self._transport.request_json("GET", f"/api/sandboxes/{self.id}/ports", retry="transient")
        return [SandboxEndpoint.from_json(item) for item in data["ports"]]

    async def unexpose_port(self, port: int) -> None:
        """Remove explicit public exposure. A service publishing the same port remains reachable."""
        await self._transport.request_empty("DELETE", f"/api/sandboxes/{self.id}/ports/{port}", retry="transient")

    async def create_port_token(self, port: int, *, ttl: Optional[str] = None) -> CreatedSandboxPortToken:
        """Authorize HTTP access to one port without making it public.

        ``ttl`` is a duration such as "1h" or "30m", up to "8760h" (365 days).
        Omit it for no expiration. Save the returned token: it is only returned
        on creation. Send it in the ``X-Archil-Token`` header.
        """
        body: dict = {"port": port}
        if ttl is not None:
            body["ttl"] = ttl
        data = await self._transport.request_json(
            "POST", f"/api/sandboxes/{self.id}/port-tokens", json=body, retry="connect"
        )
        return CreatedSandboxPortToken.from_json(data)

    async def get_port_token(self, token_id: str) -> SandboxPortToken:
        """Get token metadata. Expired and revoked tokens return not found."""
        data = await self._transport.request_json(
            "GET", f"/api/sandboxes/{self.id}/port-tokens/{token_id}", retry="transient"
        )
        return SandboxPortToken.from_json(data)

    async def _port_token_page(self, *, limit: int, cursor: Optional[str]) -> SandboxPortTokenPage:
        data, next_cursor = await self._transport.request_json_page(
            "GET", f"/api/sandboxes/{self.id}/port-tokens",
            params={"limit": limit, "cursor": cursor}, retry="transient",
        )
        return SandboxPortTokenPage(
            tokens=[SandboxPortToken.from_json(item) for item in data["tokens"]], next_cursor=next_cursor
        )

    async def list_port_tokens(
        self, *, limit: Optional[int] = None, cursor: Optional[str] = None
    ) -> list[SandboxPortToken]:
        """List token metadata across pages. ``limit`` caps the total returned."""
        tokens: list[SandboxPortToken] = []
        while True:
            remaining = None if limit is None else limit - len(tokens)
            if remaining is not None and remaining <= 0:
                return tokens
            page = await self._port_token_page(limit=100 if remaining is None else min(remaining, 100), cursor=cursor)
            tokens.extend(page.tokens)
            if not page.next_cursor:
                return tokens
            cursor = page.next_cursor

    async def list_port_token_pages(
        self, *, cursor: Optional[str] = None, page_size: int = 100
    ) -> AsyncIterator[SandboxPortTokenPage]:
        """Yield token metadata pages. Use each page's ``next_cursor`` to resume.

        Async iteration: ``async for page in sandbox.list_port_token_pages.aio(): ...``.
        """
        while True:
            page = await self._port_token_page(limit=page_size, cursor=cursor)
            yield page
            if not page.next_cursor:
                return
            cursor = page.next_cursor

    async def delete_port_token(self, token: Union[SandboxPortToken, str]) -> None:
        """Revoke a token for new connections. Existing connections remain open."""
        token_id = token if isinstance(token, str) else token.id
        await self._transport.request_empty(
            "DELETE", f"/api/sandboxes/{self.id}/port-tokens/{token_id}", retry="transient"
        )

    async def get_network(self) -> SandboxNetwork:
        data = await self._transport.request_json("GET", f"/api/sandboxes/{self.id}/network", retry="transient")
        return SandboxNetwork.from_json(data)

    async def update_network(self, network: SandboxNetwork) -> SandboxNetwork:
        data = await self._transport.request_json(
            "PUT",
            f"/api/sandboxes/{self.id}/network",
            json=network.to_json(),
            retry="transient",
        )
        return SandboxNetwork.from_json(data)

    async def set_timeout(self, timeout: Optional[int] = None, *, idle_ttl_seconds: Optional[int] = None) -> "_Sandbox":
        body = {
            key: value
            for key, value in {"timeout": timeout, "idle_ttl_seconds": idle_ttl_seconds}.items()
            if value is not None
        }
        data = await self._transport.request_json(
            "POST",
            f"/api/sandboxes/{self.id}/timeout",
            json=body,
            retry="transient",
        )
        self._data = SandboxData.from_json(data)
        return self

    async def delete(self) -> None:
        await self._transport.request_empty("DELETE", f"/api/sandboxes/{self.id}", retry="transient")


class _SandboxProcesses:
    """Deprecated: use Sandbox.run() and Sandbox.attach(); removed in the next version."""

    def __init__(self, sandbox: _Sandbox) -> None:
        self._sandbox = sandbox

    async def start(
        self,
        command: str,
        *,
        cwd: Optional[str] = None,
        terminal: Union[bool, SandboxTerminal] = False,
        env: Optional[dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        on_output: Optional[SandboxProcessOutputHandler] = None,
        collect_output: bool = True,
    ) -> _SandboxProcess:
        """Deprecated: use sandbox.run(); removed in the next version."""
        return await self._sandbox.run(
            command,
            cwd=cwd,
            terminal=terminal,
            env=env,
            timeout_seconds=timeout_seconds,
            on_output=on_output,
            collect_output=collect_output,
        )

    async def connect(
        self,
        process_id: str,
        *,
        offset: int = 0,
        on_output: Optional[SandboxProcessOutputHandler] = None,
        collect_output: bool = True,
    ) -> _SandboxProcess:
        """Deprecated: use sandbox.attach(); removed in the next version."""
        return await self._sandbox.attach(
            process_id,
            offset=offset,
            on_output=on_output,
            collect_output=collect_output,
        )
