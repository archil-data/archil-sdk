import asyncio
import json
from datetime import datetime
from typing import Union

import httpx
import pytest

import archil as archil_module
from archil import (
    Sandbox,
    SandboxEgressPolicy,
    SandboxNetwork,
    SandboxProcess,
    SandboxProcessOutput,
    SandboxProcessResult,
    SandboxStartError,
    SandboxTerminal,
)
from conftest import ok_envelope


NOW = "2026-08-14T12:00:00Z"
_CLOSED = object()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[Union[str, bytes]] = []
        self.close_reason = None
        self._messages = asyncio.Queue()

    def __aiter__(self):
        return self

    async def __anext__(self):
        message = await self._messages.get()
        if message is _CLOSED:
            raise StopAsyncIteration
        return message

    async def send(self, data: Union[str, bytes]) -> None:
        self.sent.append(data)

    async def recv(self):
        return await self.__anext__()

    async def close(self) -> None:
        await self.finish("")

    async def push(self, data: Union[str, bytes]) -> None:
        await self._messages.put(data)

    async def finish(self, reason: str) -> None:
        self.close_reason = reason
        await self._messages.put(_CLOSED)


class FakeProcessWebSocket(FakeWebSocket):
    async def send(self, data: Union[str, bytes]) -> None:
        await super().send(data)
        if isinstance(data, bytes):
            return
        request = json.loads(data)
        if request["type"] == "start":
            await self.push(json.dumps({"type": "started", "process_id": "process-1"}))
        elif request["type"] == "attach":
            await self.push(json.dumps({"type": "attached", "process_id": request["process_id"]}))
        elif request["type"] == "kill":
            await self.push(
                json.dumps(
                    {
                        "type": "killed",
                    }
                )
            )
        elif request["type"] == "resize":
            await self.push(json.dumps({"type": "resized"}))


class BlockingInputWebSocket(FakeProcessWebSocket):
    def __init__(self) -> None:
        super().__init__()
        self.input_started = asyncio.Event()
        self.release_input = asyncio.Event()

    async def send(self, data: Union[str, bytes]) -> None:
        await super().send(data)
        if isinstance(data, bytes) and not self.input_started.is_set():
            self.input_started.set()
            await self.release_input.wait()


def process_output_frame(stream: int, offset: int, data: bytes) -> bytes:
    return bytes([stream]) + offset.to_bytes(8, "big") + data


def sandbox_json(status: str = "running", **overrides) -> dict:
    return {
        "sandbox_id": "sbx-1",
        "name": "harbor-trial",
        "status": status,
        "vcpu_count": 2,
        "mem_size_mib": 4096,
        "base_image": "docker:29.7.1-dind",
        "platform": "amd64",
        "max_ttl_seconds": 3600,
        "max_concurrent_execs": 4,
        "endpoints": [{"port": 8080, "hostname": "8080.sbx.example.com"}],
        "created_at": NOW,
        "running_at": NOW if status == "running" else None,
        "last_active_at": NOW,
        **overrides,
    }


def test_create_and_list_sandboxes(archil, router):
    network_json = {
        "egress": {
            "default": "deny",
            "allow": ["github.com", "*.github.com", "140.82.112.0/20"],
            "deny": ["169.254.0.0/16"],
        }
    }

    def handler(request):
        if request.method == "POST":
            return ok_envelope(sandbox_json(network=network_json))
        return ok_envelope({"sandboxes": [sandbox_json()]})

    router.set(handler)
    sandbox = archil.sandboxes.create(
        name="harbor-trial",
        vcpu_count=2,
        mem_size_mib=4096,
        base_image="docker:29.7.1-dind",
        env={"TRIAL": "1"},
        max_ttl_seconds=3600,
        max_concurrent_execs=4,
        network=SandboxNetwork(
            egress=SandboxEgressPolicy(
                default="deny",
                allow=["github.com", "*.github.com", "140.82.112.0/20"],
                deny=["169.254.0.0/16"],
            )
        ),
    )

    assert isinstance(sandbox, Sandbox)
    assert sandbox.id == "sbx-1"
    assert sandbox.platform == "amd64"
    assert sandbox.endpoints[0].hostname == "8080.sbx.example.com"
    assert sandbox.network == SandboxNetwork(
        egress=SandboxEgressPolicy(
            default="deny",
            allow=["github.com", "*.github.com", "140.82.112.0/20"],
            deny=["169.254.0.0/16"],
        )
    )
    assert isinstance(sandbox.created_at, datetime)
    assert router.requests[0].query == {"wait": "true"}
    assert router.requests[0].json == {
        "name": "harbor-trial",
        "vcpu_count": 2,
        "mem_size_mib": 4096,
        "base_image": "docker:29.7.1-dind",
        "env": {"TRIAL": "1"},
        "max_ttl_seconds": 3600,
        "max_concurrent_execs": 4,
        "network": network_json,
    }

    listed = archil.sandboxes.list(disk="dsk-1")
    assert [item.id for item in listed] == ["sbx-1"]
    assert router.requests[1].query == {"filesystem": "dsk-1"}


def test_create_surfaces_terminal_start_failure(archil, router, monkeypatch):
    import archil._sandbox as sandbox_module

    monkeypatch.setattr(sandbox_module, "_POLL_INTERVAL_SECONDS", 0)

    def handler(request):
        status = "pending" if request.method == "POST" else "failed"
        return ok_envelope(
            sandbox_json(
                status,
                running_at=None,
                exit_reason="root filesystem failed to mount",
            )
        )

    router.set(handler)
    with pytest.raises(SandboxStartError) as caught:
        archil.sandboxes.create(name="broken")

    assert caught.value.latest.status == "failed"
    assert "root filesystem failed to mount" in str(caught.value)


@pytest.mark.asyncio
async def test_exec_starts_a_process_and_waits(archil, router, monkeypatch):
    import archil._sandbox_process as process_module

    expected = SandboxProcessResult(
        status="completed",
        exit_code=0,
        stdout="hello",
        stderr="",
    )
    calls = []

    class Process:
        async def wait(self):
            calls.append(("wait",))
            return expected

    async def start(_self, command, **kwargs):
        calls.append(("start", command, kwargs))
        return Process()

    monkeypatch.setattr(process_module._SandboxProcesses, "start", start)
    router.set(lambda request: ok_envelope(sandbox_json()))
    sandbox = await archil.sandboxes.get.aio("sbx-1")
    result = await sandbox.exec.aio(
        "printf hello",
        env={"HELLO": "world"},
        timeout_seconds=10,
    )

    assert result is expected
    assert calls == [
        (
            "start",
            "printf hello",
            {
                "terminal": False,
                "env": {"HELLO": "world"},
                "timeout_seconds": 10,
                "on_output": None,
                "collect_output": True,
            },
        ),
        ("wait",),
    ]


def test_lifecycle_fork_and_delete(archil, router, monkeypatch):
    import archil._sandbox as sandbox_module

    monkeypatch.setattr(sandbox_module, "_POLL_INTERVAL_SECONDS", 0)

    def handler(request):
        if request.url.path.endswith("/fork"):
            return ok_envelope(
                sandbox_json(
                    sandbox_id="sbx-fork",
                    name="forked",
                )
            )
        if request.url.path.endswith("/stop"):
            return ok_envelope(sandbox_json("stopped", finished_at=NOW))
        if request.method == "DELETE":
            return httpx.Response(204)
        return ok_envelope(sandbox_json())

    router.set(handler)
    sandbox = archil.sandboxes.get("sbx-1")
    fork = sandbox.fork(name="forked")
    stopped = sandbox.stop()
    stopped.delete()

    assert fork.id == "sbx-fork"
    assert stopped.status == "stopped"
    assert router.requests[1].json == {"name": "forked"}
    assert router.requests[-1].method == "DELETE"
    assert router.requests[-1].path == "/api/sandboxes/sbx-1"
    stop_request = next(request for request in router.requests if request.path.endswith("/stop"))
    assert stop_request.query == {}


def test_empty_sandbox_list(archil, router):
    responses = iter([ok_envelope(None)])
    router.set(lambda request: next(responses))
    assert archil.sandboxes.list() == []


def test_lifecycle_waiting_matches_wire_contract(archil, router, monkeypatch):
    import archil._sandbox as sandbox_module

    monkeypatch.setattr(sandbox_module, "_POLL_INTERVAL_SECONDS", 0)
    get_statuses = iter(["running", "running", "stopped", "paused", "running"])

    def handler(request):
        if request.method == "GET":
            return ok_envelope(sandbox_json(next(get_statuses)))
        operation = request.url.path.rsplit("/", 1)[-1]
        return ok_envelope(
            sandbox_json(
                {
                    "start": "pending",
                    "stop": "stopping",
                    "pause": "pausing",
                    "resume": "pending",
                }[operation]
            )
        )

    router.set(handler)
    sandbox = archil.sandboxes.get("sbx-1")
    sandbox = sandbox.start()
    sandbox = sandbox.stop()
    sandbox = sandbox.pause()
    sandbox = sandbox.resume()

    assert sandbox.status == "running"
    lifecycle_requests = [request for request in router.requests if request.method == "POST"]
    assert [request.path.rsplit("/", 1)[-1] for request in lifecycle_requests] == [
        "start",
        "stop",
        "pause",
        "resume",
    ]
    assert [request.query for request in lifecycle_requests] == [
        {"wait": "true"},
        {},
        {},
        {"wait": "true"},
    ]


def test_module_level_sandbox_helpers(monkeypatch):
    calls = []
    expected = object()

    class FakeSandboxes:
        def create(self, **kwargs):
            calls.append(("create", kwargs))
            return expected

        def list(self, **kwargs):
            calls.append(("list", kwargs))
            return [expected]

        def get(self, id):
            calls.append(("get", id))
            return expected

    monkeypatch.setattr(
        archil_module,
        "_instance",
        type("FakeClient", (), {"sandboxes": FakeSandboxes()})(),
    )

    network = SandboxNetwork(egress=SandboxEgressPolicy(default="deny", allow=["github.com"]))
    assert archil_module.create_sandbox(name="trial", network=network, wait=False) is expected
    assert archil_module.list_sandboxes(disk="dsk-1") == [expected]
    assert archil_module.get_sandbox("sbx-1") is expected
    assert calls == [
        (
            "create",
            {
                "name": "trial",
                "vcpu_count": None,
                "mem_size_mib": None,
                "base_image": None,
                "env": None,
                "max_ttl_seconds": None,
                "max_concurrent_execs": None,
                "network": network,
                "wait": False,
            },
        ),
        ("list", {"disk": "dsk-1"}),
        ("get", "sbx-1"),
    ]


@pytest.mark.asyncio
async def test_process_disconnect_and_resume_with_streamed_input(archil, router, monkeypatch):
    import archil._sandbox_process as process_module

    sockets = []

    async def connect(url: str):
        socket = FakeProcessWebSocket()
        socket.url = url
        sockets.append(socket)
        return socket

    def handler(request):
        if request.url.path.endswith("/connections"):
            return ok_envelope(
                {
                    "url": "wss://sandbox.example/ws?token=signed",
                    "expires_at": NOW,
                }
            )
        return ok_envelope(sandbox_json())

    monkeypatch.setattr(process_module, "_websocket_connect", connect)
    router.set(handler)
    output = []
    sandbox = await archil.sandboxes.get.aio("sbx-1")
    process = await sandbox.processes.start.aio(
        "cat",
        env={"HELLO": "world"},
        timeout_seconds=10,
        on_output=output.append,
    )
    socket = sockets[0]

    assert isinstance(process, SandboxProcess)
    assert process.id == "process-1"
    assert process.connected
    assert socket.url == "wss://sandbox.example/ws?token=signed"
    assert json.loads(socket.sent[0]) == {
        "type": "start",
        "command": "cat",
        "terminal": False,
        "env": {"HELLO": "world"},
        "timeout_seconds": 10,
    }

    await socket.push(process_output_frame(1, 0, b"hello\n"))
    await asyncio.sleep(0)
    await process.send_input.aio(bytes(2 * 1024 * 1024 + 3))
    await socket.push(process_output_frame(1, 6, b"during\n"))
    await asyncio.sleep(0)
    await process.close_stdin.aio()

    chunks = [message for message in socket.sent if isinstance(message, bytes)]
    assert [len(chunk) for chunk in chunks] == [
        1024 * 1024,
        1024 * 1024,
        3,
    ]
    assert chunks[0] == chunks[1]
    assert json.loads(socket.sent[-1]) == {"type": "close_stdin"}
    assert output == [
        SandboxProcessOutput("stdout", 0, b"hello\n"),
        SandboxProcessOutput("stdout", 6, b"during\n"),
    ]

    cursor = process.cursor
    await process.disconnect.aio()
    assert not process.connected

    resumed = await sandbox.processes.connect.aio(process.id, offset=cursor)
    resumed_socket = sockets[1]
    assert json.loads(resumed_socket.sent[0]) == {
        "type": "attach",
        "process_id": "process-1",
        "offset": 13,
    }
    await resumed_socket.push(process_output_frame(2, 13, b"warning\n"))
    await resumed_socket.push(
        json.dumps(
            {
                "type": "exit",
                "status": "completed",
                "exit_code": 0,
                "cursor": 21,
            }
        )
    )
    result = await resumed.wait.aio()

    assert result.status == "completed"
    assert result.exit_code == 0
    assert result.stdout == ""
    assert result.stderr == "warning\n"
    assert resumed.cursor == 21
    await resumed.disconnect.aio()


@pytest.mark.asyncio
async def test_process_stdin_close_waits_for_writes():
    from archil._sandbox_process import _SandboxProcess

    socket = BlockingInputWebSocket()

    async def connect():
        return socket

    async def control(_request: dict[str, object]):
        pass

    process = _SandboxProcess("", 0, None, True, connect, control)
    await process._connect(
        {
            "type": "start",
            "command": "cat",
            "terminal": False,
            "env": {},
        },
        "started",
    )

    writing = asyncio.create_task(process.send_input(bytes(2 * 1024 * 1024)))
    await socket.input_started.wait()
    closing = asyncio.create_task(process.close_stdin())
    await asyncio.sleep(0)
    assert not closing.done()

    socket.release_input.set()
    await asyncio.gather(writing, closing)
    assert [type(message) for message in socket.sent[1:]] == [bytes, bytes, str]
    assert json.loads(socket.sent[-1]) == {"type": "close_stdin"}
    await process.disconnect()


@pytest.mark.asyncio
async def test_terminal_process_input_resize_and_kill(archil, router, monkeypatch):
    import archil._sandbox_process as process_module

    sockets = []

    async def connect(_url: str):
        socket = FakeProcessWebSocket()
        sockets.append(socket)
        return socket

    router.set(
        lambda request: ok_envelope(
            {"url": "wss://sandbox.example/ws", "expires_at": NOW}
            if request.url.path.endswith("/connections")
            else sandbox_json()
        )
    )
    monkeypatch.setattr(process_module, "_websocket_connect", connect)
    sandbox = await archil.sandboxes.get.aio("sbx-1")
    output = []
    process = await sandbox.processes.start.aio(
        "codex",
        terminal=SandboxTerminal(cols=132, rows=43),
        on_output=output.append,
        collect_output=False,
    )
    socket = sockets[0]
    await socket.push(process_output_frame(1, 0, b"ready\n"))
    await asyncio.sleep(0)
    await process.send_input.aio("Review this repository\n")
    await process.resize.aio(cols=160, rows=50)
    result = await process.kill.aio()

    assert json.loads(socket.sent[0])["terminal"] == {"cols": 132, "rows": 43}
    controls = [json.loads(message)["type"] for message in socket.sent if isinstance(message, str)]
    assert controls == ["start"]
    assert json.loads(sockets[1].sent[0]) == {
        "type": "resize",
        "process_id": "process-1",
        "cols": 160,
        "rows": 50,
    }
    assert json.loads(sockets[2].sent[0]) == {
        "type": "kill",
        "process_id": "process-1",
    }
    assert output == [SandboxProcessOutput("stdout", 0, b"ready\n")]
    assert result is None
    await process.disconnect.aio()


@pytest.mark.asyncio
async def test_process_exit_closes_stdin_locally(archil, router, monkeypatch):
    import archil._sandbox_process as process_module

    socket = FakeProcessWebSocket()

    async def connect(_url: str):
        return socket

    router.set(
        lambda request: ok_envelope(
            {"url": "wss://sandbox.example/ws", "expires_at": NOW}
            if request.url.path.endswith("/connections")
            else sandbox_json()
        )
    )
    monkeypatch.setattr(process_module, "_websocket_connect", connect)
    sandbox = await archil.sandboxes.get.aio("sbx-1")
    process = await sandbox.processes.start.aio("cat")

    await process.send_input.aio(b"input")
    await socket.push(
        json.dumps(
            {
                "type": "exit",
                "status": "completed",
                "exit_code": 0,
                "cursor": 0,
            }
        )
    )

    assert (await process.wait.aio()).status == "completed"
    with pytest.raises(RuntimeError, match="stdin is closed"):
        await process.send_input.aio(b"later")
    await process.disconnect.aio()


@pytest.mark.asyncio
async def test_process_callback_errors_do_not_hide_connection_errors():
    from archil._sandbox_process import _SandboxProcess

    socket = FakeProcessWebSocket()

    async def connect():
        return socket

    async def control(_request: dict[str, object]):
        pass

    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    callback_error = loop.create_future()

    def capture_callback_error(_loop, context):
        callback_error.set_result(context.get("exception"))

    loop.set_exception_handler(capture_callback_error)

    def on_output(_output):
        raise RuntimeError("callback failed")

    try:
        process = _SandboxProcess("", 0, on_output, True, connect, control)
        await process._connect(
            {
                "type": "start",
                "command": "echo hello",
                "terminal": False,
                "env": {},
            },
            "started",
        )
        await socket.push(process_output_frame(1, 0, b"hello\n"))
        error = await asyncio.wait_for(callback_error, 1)

        assert process.connected
        assert str(error) == "callback failed"

        await socket.push(
            json.dumps(
                {
                    "type": "error",
                    "error": "process_failed",
                    "message": "specific runtime failure",
                }
            )
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        with pytest.raises(ConnectionError) as exc_info:
            await process.wait()
        assert str(exc_info.value.__cause__) == ("process_failed: specific runtime failure")
    finally:
        loop.set_exception_handler(previous_handler)
