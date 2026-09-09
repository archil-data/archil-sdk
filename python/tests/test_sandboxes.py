import asyncio
import json
from datetime import datetime
from typing import Union

import httpx
import pytest

import archil as archil_module
from archil import (
    ArchilApiError,
    Sandbox,
    SandboxEgressPolicy,
    SandboxEgressRule,
    SandboxEgressTransform,
    SandboxNetwork,
    SandboxProcess,
    SandboxProcessOutput,
    SandboxProcessResult,
    SandboxStartError,
    SandboxTerminal,
)
from conftest import error_envelope, ok_envelope


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


@pytest.mark.asyncio
async def test_process_connection_retries_transient_control_plane_failures(archil, router, monkeypatch):
    import archil._sandbox_process as process_module
    import archil._http as http_module

    connection_attempts = 0

    def handler(request):
        nonlocal connection_attempts
        if not request.url.path.endswith("/connections"):
            return ok_envelope(sandbox_json())
        connection_attempts += 1
        if connection_attempts == 1:
            raise httpx.ConnectError("TLS handshake failed", request=request)
        if connection_attempts == 2:
            return error_envelope(503, "temporarily unavailable")
        return ok_envelope({"url": "wss://sandbox.example/ws", "expires_at": NOW})

    async def connect(_url: str):
        return FakeProcessWebSocket()

    router.set(handler)
    monkeypatch.setattr(process_module, "_websocket_connect", connect)
    monkeypatch.setattr(http_module, "_retry_delay", lambda _attempt: 0)
    sandbox = await archil.sandboxes.get.aio("sbx-1")

    process = await sandbox.processes.start.aio("true")

    assert connection_attempts == 3
    await process.disconnect.aio()


@pytest.mark.asyncio
async def test_process_connection_does_not_retry_non_transient_api_errors(archil, router, monkeypatch):
    connection_attempts = 0

    def handler(request):
        nonlocal connection_attempts
        if not request.url.path.endswith("/connections"):
            return ok_envelope(sandbox_json())
        connection_attempts += 1
        return error_envelope(409, "sandbox is not running")

    router.set(handler)
    sandbox = await archil.sandboxes.get.aio("sbx-1")

    with pytest.raises(ArchilApiError) as exc_info:
        await sandbox.processes.start.aio("true")

    assert exc_info.value.status == 409
    assert connection_attempts == 1


@pytest.mark.asyncio
async def test_process_connection_retries_websocket_handshake_failures(archil, router, monkeypatch):
    import archil._sandbox_process as process_module

    connection_urls = []

    def handler(request):
        if not request.url.path.endswith("/connections"):
            return ok_envelope(sandbox_json())
        connection_number = len(connection_urls) + 1
        return ok_envelope(
            {
                "url": f"wss://sandbox.example/ws?token={connection_number}",
                "expires_at": NOW,
            }
        )

    async def connect(url: str):
        connection_urls.append(url)
        if len(connection_urls) == 1:
            raise OSError("TLS handshake failed")
        return FakeProcessWebSocket()

    router.set(handler)
    monkeypatch.setattr(process_module, "_websocket_connect", connect)
    monkeypatch.setattr(process_module, "_retry_delay", lambda _attempt: 0)
    sandbox = await archil.sandboxes.get.aio("sbx-1")

    process = await sandbox.processes.start.aio("true")

    assert connection_urls == [
        "wss://sandbox.example/ws?token=1",
        "wss://sandbox.example/ws?token=2",
    ]
    await process.disconnect.aio()


@pytest.mark.asyncio
async def test_process_connection_gives_up_after_retry_budget(archil, router, monkeypatch):
    import archil._http as http_module

    connection_attempts = 0

    def handler(request):
        nonlocal connection_attempts
        if not request.url.path.endswith("/connections"):
            return ok_envelope(sandbox_json())
        connection_attempts += 1
        raise httpx.ConnectError("TLS handshake failed", request=request)

    router.set(handler)
    monkeypatch.setattr(http_module, "_retry_delay", lambda _attempt: 0)
    sandbox = await archil.sandboxes.get.aio("sbx-1")

    with pytest.raises(ConnectionError, match="Process connection failed") as exc_info:
        await sandbox.processes.start.aio("true")

    assert isinstance(exc_info.value.__cause__, httpx.ConnectError)
    assert connection_attempts == 4


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
        "idle_ttl_seconds": 30,
        "max_concurrent_execs": 4,
        "endpoints": [{"port": 8080, "hostname": "8080.sbx.example.com"}],
        "created_at": NOW,
        "running_at": NOW if status == "running" else None,
        "last_active_at": NOW,
        **overrides,
    }


@pytest.mark.asyncio
async def test_sandbox_control_plane_calls_select_safe_retry_modes():
    from archil._models import SandboxData
    from archil._sandbox import _Sandbox
    from archil._sandboxes import _Sandboxes

    calls = []

    class RecordingTransport:
        async def request_json(self, method, path, *, retry="none", **_kwargs):
            calls.append((method, path, retry))
            if method == "GET" and path == "/api/sandboxes":
                return {"sandboxes": []}
            if path.endswith("/network"):
                return {}
            return sandbox_json()

        async def request_empty(self, method, path, *, retry="none", **_kwargs):
            calls.append((method, path, retry))

    transport = RecordingTransport()
    sandboxes = _Sandboxes(transport)
    sandbox = _Sandbox(transport, SandboxData.from_json(sandbox_json()))

    await sandboxes.list()
    await sandboxes.get("sbx-1")
    await sandboxes.create(wait=False)
    await sandbox.refresh()
    await sandbox.start(wait=False)
    await sandbox.stop(wait=False)
    await sandbox.pause(wait=False)
    await sandbox.resume(wait=False)
    await sandbox.fork(wait=False)
    await sandbox.get_network()
    await sandbox.update_network(SandboxNetwork())
    await sandbox.set_timeout(3600)
    await sandbox.delete()

    assert calls == [
        ("GET", "/api/sandboxes", "transient"),
        ("GET", "/api/sandboxes/sbx-1", "transient"),
        ("POST", "/api/sandboxes", "connect"),
        ("GET", "/api/sandboxes/sbx-1", "transient"),
        ("POST", "/api/sandboxes/sbx-1/start", "transient"),
        ("POST", "/api/sandboxes/sbx-1/stop", "transient"),
        ("POST", "/api/sandboxes/sbx-1/pause", "transient"),
        ("POST", "/api/sandboxes/sbx-1/resume", "transient"),
        ("POST", "/api/sandboxes/sbx-1/fork", "connect"),
        ("GET", "/api/sandboxes/sbx-1/network", "transient"),
        ("PUT", "/api/sandboxes/sbx-1/network", "transient"),
        ("POST", "/api/sandboxes/sbx-1/timeout", "transient"),
        ("DELETE", "/api/sandboxes/sbx-1", "transient"),
    ]


@pytest.mark.asyncio
async def test_sandbox_create_retries_only_connection_establishment_failures(archil, router, monkeypatch):
    import archil._http as http_module

    attempts = 0

    def connection_failure_then_success(request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ConnectError("TLS handshake failed", request=request)
        return ok_envelope(sandbox_json())

    monkeypatch.setattr(http_module, "_retry_delay", lambda _attempt: 0)
    router.set(connection_failure_then_success)

    await archil.sandboxes.create.aio(wait=False)

    assert attempts == 2

    attempts = 0

    def ambiguous_failure(_request):
        nonlocal attempts
        attempts += 1
        return error_envelope(503, "temporarily unavailable")

    router.set(ambiguous_failure)

    with pytest.raises(ArchilApiError) as exc_info:
        await archil.sandboxes.create.aio(wait=False)

    assert exc_info.value.status == 503
    assert attempts == 1


@pytest.mark.asyncio
async def test_sandbox_lifecycle_retries_transient_failures(archil, router, monkeypatch):
    import archil._http as http_module

    stop_attempts = 0

    def handler(request):
        nonlocal stop_attempts
        if not request.url.path.endswith("/stop"):
            return ok_envelope(sandbox_json())
        stop_attempts += 1
        if stop_attempts == 1:
            return error_envelope(503, "temporarily unavailable")
        return ok_envelope(sandbox_json(status="stopped"))

    monkeypatch.setattr(http_module, "_retry_delay", lambda _attempt: 0)
    router.set(handler)
    sandbox = await archil.sandboxes.get.aio("sbx-1")

    stopped = await sandbox.stop.aio(wait=False)

    assert stopped.status == "stopped"
    assert stop_attempts == 2


def test_create_and_list_sandboxes(archil, router):
    network_json = {
        "egress": {
            "default": "deny",
            "allow": [
                "github.com",
                "*.github.com",
                "140.82.112.0/20",
                {
                    "target": "api.openai.com",
                    "transform": {"headers": {"Authorization": "Bearer brokered-token"}},
                },
            ],
            "deny": ["169.254.0.0/16"],
        }
    }

    def handler(request):
        if request.method == "POST":
            return ok_envelope(sandbox_json())
        return ok_envelope({"sandboxes": [sandbox_json()]})

    router.set(handler)
    sandbox = archil.sandboxes.create(
        name="harbor-trial",
        vcpu_count=2,
        mem_size_mib=4096,
        base_image="docker:29.7.1-dind",
        env={"TRIAL": "1"},
        max_ttl_seconds=3600,
        idle_ttl_seconds=30,
        max_concurrent_execs=4,
        network=SandboxNetwork(
            egress=SandboxEgressPolicy(
                default="deny",
                allow=[
                    "github.com",
                    "*.github.com",
                    "140.82.112.0/20",
                    SandboxEgressRule(
                        target="api.openai.com",
                        transform=SandboxEgressTransform(
                            headers={"Authorization": "Bearer brokered-token"}
                        ),
                    ),
                ],
                deny=["169.254.0.0/16"],
            )
        ),
    )

    assert isinstance(sandbox, Sandbox)
    assert sandbox.id == "sbx-1"
    assert sandbox.platform == "amd64"
    assert sandbox.idle_ttl_seconds == 30
    assert sandbox.endpoints[0].hostname == "8080.sbx.example.com"
    assert isinstance(sandbox.created_at, datetime)
    assert router.requests[0].query == {"wait": "true"}
    assert router.requests[0].json == {
        "name": "harbor-trial",
        "vcpu_count": 2,
        "mem_size_mib": 4096,
        "base_image": "docker:29.7.1-dind",
        "env": {"TRIAL": "1"},
        "max_ttl_seconds": 3600,
        "idle_ttl_seconds": 30,
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


def test_get_and_update_network_use_active_runtime_policy(archil, router):
    router.set(
        lambda request: (
            ok_envelope(network.to_json()) if request.url.path.endswith("/network") else ok_envelope(sandbox_json())
        )
    )
    sandbox = archil.sandboxes.get("sbx-1")
    network = SandboxNetwork(
        egress=SandboxEgressPolicy(
            default="deny",
            allow=["github.com", "140.82.112.0/20"],
            deny=["169.254.0.0/16"],
        )
    )

    assert sandbox.get_network() == network
    assert router.requests[-1].method == "GET"
    assert router.requests[-1].path == "/api/sandboxes/sbx-1/network"

    assert sandbox.update_network(network) == network
    assert router.requests[-1].method == "PUT"
    assert router.requests[-1].path == "/api/sandboxes/sbx-1/network"
    assert router.requests[-1].json == network.to_json()

    unrestricted = SandboxNetwork()
    router.set(lambda request: ok_envelope(unrestricted.to_json()))
    assert sandbox.update_network(unrestricted) == unrestricted
    assert router.requests[-1].json == {}


@pytest.mark.parametrize("idle_ttl_seconds", [None, 0, 30])
def test_create_serializes_idle_ttl(archil, router, idle_ttl_seconds):
    router.set(lambda request: ok_envelope(sandbox_json()))
    archil.sandboxes.create(idle_ttl_seconds=idle_ttl_seconds)
    assert router.requests[-1].json == ({} if idle_ttl_seconds is None else {"idle_ttl_seconds": idle_ttl_seconds})


def test_older_sandbox_response_defaults_idle_ttl_to_disabled(archil, router):
    data = sandbox_json()
    del data["idle_ttl_seconds"]
    router.set(lambda request: ok_envelope(data))
    assert archil.sandboxes.get("sbx-1").idle_ttl_seconds == 0


@pytest.mark.parametrize("use_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("body", [
    {"timeout": 86400},
    {"idle_ttl_seconds": 45},
    {"idle_ttl_seconds": 0},
    {"timeout": 86400, "idle_ttl_seconds": 45},
])
@pytest.mark.asyncio
async def test_set_timeout_retries_and_refreshes_sandbox_fields(archil, router, body, use_async, monkeypatch):
    import archil._http as http_module

    monkeypatch.setattr(http_module, "_retry_delay", lambda _attempt: 0)
    attempts = 0
    expires_at = "2026-08-15T12:00:00Z"
    updated = sandbox_json(
        max_ttl_seconds=body.get("timeout", 3600),
        idle_ttl_seconds=body.get("idle_ttl_seconds", 30),
        expires_at=expires_at,
    )

    def handler(request):
        nonlocal attempts
        if request.url.path.endswith("/timeout"):
            attempts += 1
            if attempts == 1:
                raise httpx.ReadError("connection lost", request=request)
            if attempts < 4:
                return error_envelope(429 if attempts == 2 else 503, "unavailable")
            return ok_envelope(updated)
        return ok_envelope(sandbox_json())

    router.set(handler)
    sandbox = archil.sandboxes.get("sbx-1")

    args = (body["timeout"],) if "timeout" in body else ()
    kwargs = {"idle_ttl_seconds": body["idle_ttl_seconds"]} if "idle_ttl_seconds" in body else {}
    result = await sandbox.set_timeout.aio(*args, **kwargs) if use_async else sandbox.set_timeout(*args, **kwargs)
    assert result is sandbox
    assert attempts == 4
    assert sandbox.max_ttl_seconds == updated["max_ttl_seconds"]
    assert sandbox.idle_ttl_seconds == updated["idle_ttl_seconds"]
    assert not hasattr(sandbox, "expires_at")
    assert router.requests[-1].method == "POST"
    assert router.requests[-1].path == "/api/sandboxes/sbx-1/timeout"
    assert router.requests[-1].json == body


@pytest.mark.parametrize("status", [400, 409])
def test_set_timeout_surfaces_errors_without_retrying_or_changing_fields(archil, router, status):
    router.set(lambda request: ok_envelope(sandbox_json()))
    sandbox = archil.sandboxes.get("sbx-1")
    router.set(lambda request: error_envelope(status, "invalid TTL"))
    request_count = len(router.requests)
    with pytest.raises(ArchilApiError, match="invalid TTL") as caught:
        sandbox.set_timeout(idle_ttl_seconds=-1)
    assert caught.value.status == status
    assert len(router.requests) == request_count + 1
    assert sandbox.max_ttl_seconds == 3600
    assert sandbox.idle_ttl_seconds == 30


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
    assert archil_module.create_sandbox(name="trial", idle_ttl_seconds=0, network=network, wait=False) is expected
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
                "idle_ttl_seconds": 0,
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
