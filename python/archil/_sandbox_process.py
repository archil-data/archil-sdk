from __future__ import annotations

import asyncio
import codecs
import json
from typing import Awaitable, Callable, Optional, Union

from websockets.asyncio.client import ClientConnection, connect as _websocket_connect
from websockets.exceptions import WebSocketException

from ._http import _Transport
from ._models import (
    SandboxProcessOutput,
    SandboxProcessOutputHandler,
    SandboxProcessResult,
    SandboxProcessStatus,
    SandboxProcessStream,
    SandboxTerminal,
)

_STDIN_CHUNK_BYTES = 1024 * 1024
_STDIN_RETRY_SECONDS = 0.01


def _connection_url(url: str) -> str:
    return f"{url}{'&' if '?' in url else '?'}protocol=process-v1"


class _SandboxProcesses:
    def __init__(self, transport: _Transport, sandbox_id: str) -> None:
        self._transport = transport
        self._sandbox_id = sandbox_id

    async def start(
        self,
        command: str,
        *,
        terminal: Union[bool, SandboxTerminal] = False,
        env: Optional[dict[str, str]] = None,
        timeout_seconds: Optional[int] = None,
        on_output: Optional[SandboxProcessOutputHandler] = None,
    ) -> "_SandboxProcess":
        process = _SandboxProcess("", 0, on_output, self._new_connection)
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
        if timeout_seconds is not None:
            request["timeout_seconds"] = timeout_seconds
        await process._connect(request, "started")
        return process

    async def connect(
        self,
        process_id: str,
        *,
        offset: int = 0,
        on_output: Optional[SandboxProcessOutputHandler] = None,
    ) -> "_SandboxProcess":
        process = _SandboxProcess(process_id, offset, on_output, self._new_connection)
        await process._connect(
            {"type": "attach", "process_id": process_id, "offset": offset},
            "attached",
        )
        return process

    async def _new_connection(self) -> ClientConnection:
        data = await self._transport.request_json(
            "POST", f"/api/sandboxes/{self._sandbox_id}/connections"
        )
        try:
            return await _websocket_connect(_connection_url(data["url"]))
        except (OSError, TimeoutError, WebSocketException) as exc:
            raise ConnectionError("Process connection failed") from exc


class _SandboxProcess:
    def __init__(
        self,
        process_id: str,
        cursor: int,
        on_output: Optional[SandboxProcessOutputHandler],
        new_connection: Callable[[], Awaitable[ClientConnection]],
    ) -> None:
        self._id = process_id
        self._cursor = cursor
        self._on_output = on_output
        self._new_connection = new_connection
        self._socket: Optional[ClientConnection] = None
        self._receiver: Optional[asyncio.Task[None]] = None
        self._ready: Optional[asyncio.Future[None]] = None
        self._closed: Optional[asyncio.Future[None]] = None
        self._terminal: Optional[asyncio.Future[SandboxProcessResult]] = None
        self._pending_input: Optional[asyncio.Future[bool]] = None
        self._connection_error: Optional[BaseException] = None
        self._result: Optional[SandboxProcessResult] = None
        self._stdin_closed = False
        self._stdin_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._stdout_decoder = self._decoder()
        self._stderr_decoder = self._decoder()
        self.status: SandboxProcessStatus = "running"
        self.stdout = ""
        self.stderr = ""

    @property
    def id(self) -> str:
        return self._id

    @property
    def cursor(self) -> int:
        return self._cursor

    @property
    def connected(self) -> bool:
        return self._socket is not None

    async def send_input(self, data: Union[str, bytes, bytearray, memoryview]) -> None:
        payload = data.encode() if isinstance(data, str) else bytes(data)
        async with self._stdin_lock:
            if self._stdin_closed:
                raise RuntimeError("Process stdin is closed")
            for offset in range(0, len(payload), _STDIN_CHUNK_BYTES):
                chunk = payload[offset : offset + _STDIN_CHUNK_BYTES]
                while not await self._send_input_chunk(chunk):
                    await asyncio.sleep(_STDIN_RETRY_SECONDS)

    async def resize(self, *, cols: int, rows: int) -> None:
        await self._send_json({"type": "resize", "cols": cols, "rows": rows})

    async def close_stdin(self) -> None:
        async with self._stdin_lock:
            if self._stdin_closed:
                return
            self._stdin_closed = True
            await self._send_json({"type": "close_stdin"})

    async def disconnect(self) -> None:
        socket = self._socket
        closed = self._closed
        if socket is None:
            return
        self._socket = None
        await socket.close()
        if closed is not None:
            await closed

    async def wait(self) -> SandboxProcessResult:
        if self._result is not None:
            return self._result
        if self._socket is None or self._terminal is None or self._closed is None:
            raise RuntimeError("Process is disconnected")
        await asyncio.wait((self._terminal, self._closed), return_when=asyncio.FIRST_COMPLETED)
        if self._result is not None:
            return self._result
        if self._connection_error is not None:
            raise ConnectionError("Process connection failed") from self._connection_error
        raise ConnectionError("Process connection closed before exit")

    async def kill(self) -> SandboxProcessResult:
        if self._result is not None:
            return self._result
        await self._send_json({"type": "kill"})
        return await self.wait()

    async def _connect(self, request: dict[str, object], expected_ready: str) -> None:
        loop = asyncio.get_running_loop()
        self._ready = loop.create_future()
        self._closed = loop.create_future()
        self._terminal = loop.create_future()
        socket = await self._new_connection()
        self._socket = socket
        self._receiver = asyncio.create_task(self._receive(socket, expected_ready))
        try:
            await self._send_json(request)
            await self._ready
        except BaseException:
            await socket.close()
            raise

    async def _receive(self, socket: ClientConnection, expected_ready: str) -> None:
        try:
            async for message in socket:
                if isinstance(message, str):
                    self._handle_control(json.loads(message), expected_ready)
                else:
                    self._handle_output(bytes(message))
        except Exception as error:
            self._connection_error = error
            self._fail(self._ready, error)
            self._fail(self._pending_input, error)
            await socket.close()
        finally:
            if self._socket is socket:
                self._socket = None
            self._fail(self._ready, ConnectionError("Process connection closed before ready"))
            self._fail(
                self._pending_input,
                ConnectionError("Process connection closed before accepting input"),
            )
            if self._closed is not None and not self._closed.done():
                self._closed.set_result(None)

    async def _send_input_chunk(self, data: bytes) -> bool:
        response = asyncio.get_running_loop().create_future()
        self._pending_input = response
        try:
            await self._send(data)
            return await response
        finally:
            if self._pending_input is response:
                self._pending_input = None

    async def _send_json(self, message: dict[str, object]) -> None:
        await self._send(json.dumps(message, separators=(",", ":")))

    async def _send(self, message: Union[str, bytes]) -> None:
        socket = self._socket
        if socket is None:
            raise RuntimeError("Process is disconnected")
        async with self._send_lock:
            await socket.send(message)

    def _handle_control(self, event: dict, expected_ready: str) -> None:
        event_type = event.get("type")
        if event_type in ("started", "attached"):
            if event_type != expected_ready:
                raise RuntimeError(f"Expected {expected_ready}, received {event_type}")
            process_id = event["process_id"]
            if self._id and self._id != process_id:
                raise RuntimeError("Runtime returned a different process ID")
            self._id = process_id
            if self._ready is not None and not self._ready.done():
                self._ready.set_result(None)
            return
        if event_type in ("input_accepted", "input_backpressure"):
            pending = self._pending_input
            self._pending_input = None
            if pending is not None and not pending.done():
                pending.set_result(event_type == "input_accepted")
            return
        if event_type == "input_closed":
            self._stdin_closed = True
            self._fail(self._pending_input, RuntimeError("Process stdin is closed"))
            return
        if event_type == "exit":
            self._finish(event)
            return
        if event_type == "error":
            raise RuntimeError(f"{event['error']}: {event['message']}")

    def _handle_output(self, frame: bytes) -> None:
        if len(frame) < 9 or frame[0] not in (1, 2):
            raise RuntimeError("Invalid process output frame")
        offset = int.from_bytes(frame[1:9], "big")
        payload = frame[9:]
        end = offset + len(payload)
        if end <= self._cursor:
            return
        if offset > self._cursor:
            self._flush_decoders()
            self._cursor = offset
        skip = max(0, self._cursor - offset)
        unread = payload[skip:]
        unread_offset = offset + skip
        self._cursor = end
        stream: SandboxProcessStream = "stdout" if frame[0] == 1 else "stderr"
        decoder = self._stdout_decoder if stream == "stdout" else self._stderr_decoder
        self._append_text(stream, decoder.decode(unread))
        if self._on_output is not None:
            self._on_output(SandboxProcessOutput(stream, unread_offset, unread))

    def _finish(self, event: dict) -> None:
        if self._result is not None:
            return
        self._flush_decoders()
        self._cursor = max(self._cursor, event["cursor"])
        self.status = event["status"]
        self._result = SandboxProcessResult(
            status=event["status"],
            exit_code=event.get("exit_code"),
            exit_reason=event.get("exit_reason"),
            stdout=self.stdout,
            stderr=self.stderr,
        )
        if self._terminal is not None and not self._terminal.done():
            self._terminal.set_result(self._result)

    @staticmethod
    def _decoder():
        return codecs.getincrementaldecoder("utf-8")(errors="replace")

    def _append_text(self, stream: SandboxProcessStream, data: str) -> None:
        if stream == "stdout":
            self.stdout += data
        else:
            self.stderr += data

    def _flush_decoders(self) -> None:
        self._append_text("stdout", self._stdout_decoder.decode(b"", final=True))
        self._append_text("stderr", self._stderr_decoder.decode(b"", final=True))
        self._stdout_decoder = self._decoder()
        self._stderr_decoder = self._decoder()

    @staticmethod
    def _fail(future: Optional[asyncio.Future], error: BaseException) -> None:
        if future is not None and not future.done():
            future.set_exception(error)
