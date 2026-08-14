import asyncio
import json
import shlex
from datetime import datetime

import httpx
import pytest

import archil as archil_module
from archil import Sandbox, SandboxExec, SandboxPty, SandboxStartError
from conftest import ok_envelope


NOW = "2026-08-14T12:00:00Z"
_CLOSED = object()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.close_reason = None
        self._messages = asyncio.Queue()

    def __aiter__(self):
        return self

    async def __anext__(self):
        message = await self._messages.get()
        if message is _CLOSED:
            raise StopAsyncIteration
        return message

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        await self.finish("")

    async def push(self, data: str) -> None:
        await self._messages.put(data)

    async def finish(self, reason: str) -> None:
        self.close_reason = reason
        await self._messages.put(_CLOSED)


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


def exec_json(status: str = "completed", **overrides) -> dict:
    return {
        "sandbox_id": "sbx-1",
        "exec_id": "exec-1",
        "command": "echo hello",
        "status": status,
        "started_at": NOW,
        "exit_code": 0 if status != "running" else None,
        "stdout": "hello\n" if status != "running" else None,
        "stderr": "" if status != "running" else None,
        **overrides,
    }


def test_create_and_list_sandboxes(archil, router):
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
        max_concurrent_execs=4,
    )

    assert isinstance(sandbox, Sandbox)
    assert sandbox.id == "sbx-1"
    assert sandbox.platform == "amd64"
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
        "max_concurrent_execs": 4,
    }

    listed = archil.sandboxes.list(disk="dsk-1")
    assert [item.id for item in listed] == ["sbx-1"]
    assert router.requests[1].query == {"filesystem": "dsk-1"}


@pytest.mark.asyncio
async def test_create_and_exec_poll_server_wait_expiry(archil, router, monkeypatch):
    import archil._sandbox as sandbox_module

    monkeypatch.setattr(sandbox_module, "_POLL_INTERVAL_SECONDS", 0)
    gets = 0

    def handler(request):
        nonlocal gets
        if request.method == "POST" and request.url.path == "/api/sandboxes":
            return ok_envelope(sandbox_json("pending", running_at=None))
        if request.method == "GET" and request.url.path == "/api/sandboxes/sbx-1":
            return ok_envelope(sandbox_json())
        if request.method == "POST" and request.url.path.endswith("/execs"):
            return ok_envelope(exec_json("running"))
        if request.method == "GET" and request.url.path.endswith("/execs/exec-1"):
            gets += 1
            return ok_envelope(exec_json())
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    router.set(handler)
    sandbox = await archil.sandboxes.create.aio(name="harbor-trial")
    result = await sandbox.exec.aio("echo hello", env={"A": "b"}, timeout_seconds=30)

    assert isinstance(result, SandboxExec)
    assert result.status == "completed"
    assert result.stdout == "hello\n"
    assert gets == 1
    assert router.requests[2].json == {
        "command": "echo hello",
        "env": {"A": "b"},
        "timeout_seconds": 30,
    }


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


def test_lifecycle_fork_connection_and_delete(archil, router, monkeypatch):
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
        if request.url.path.endswith("/connections"):
            return ok_envelope({"url": "wss://sandbox.example/ws", "expires_at": NOW})
        if request.url.path.endswith("/stop"):
            return ok_envelope(sandbox_json("stopped", finished_at=NOW))
        if request.method == "DELETE":
            return httpx.Response(204)
        return ok_envelope(sandbox_json())

    router.set(handler)
    sandbox = archil.sandboxes.get("sbx-1")
    fork = sandbox.fork(name="forked")
    connection = fork.create_connection()
    stopped = sandbox.stop()
    stopped.delete()

    assert fork.id == "sbx-fork"
    assert connection.url == "wss://sandbox.example/ws"
    assert stopped.status == "stopped"
    assert router.requests[1].json == {"name": "forked"}
    assert router.requests[-1].method == "DELETE"
    assert router.requests[-1].path == "/api/sandboxes/sbx-1"
    stop_request = next(request for request in router.requests if request.path.endswith("/stop"))
    assert stop_request.query == {}


def test_empty_sandbox_and_exec_lists(archil, router):
    responses = iter([ok_envelope(None), ok_envelope(sandbox_json()), ok_envelope(None)])
    router.set(lambda request: next(responses))
    assert archil.sandboxes.list() == []
    assert archil.sandboxes.get("sbx-1").list_execs() == []


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


def test_exec_management_methods(archil, router):
    def handler(request):
        if "/execs" not in request.url.path:
            return ok_envelope(sandbox_json())
        if request.url.path.endswith("/execs"):
            return ok_envelope({"execs": [exec_json()]})
        if request.method == "POST":
            return ok_envelope(exec_json("cancelled"))
        return ok_envelope(exec_json())

    router.set(handler)
    sandbox = archil.sandboxes.get("sbx-1")
    listed = sandbox.list_execs()
    fetched = sandbox.get_exec("exec-1")
    cancelled = sandbox.cancel_exec("exec-1")
    refreshed = fetched.refresh()
    cancelled_again = refreshed.cancel()

    assert [execution.id for execution in listed] == ["exec-1"]
    assert fetched.status == "completed"
    assert cancelled.status == "cancelled"
    assert refreshed.status == "completed"
    assert cancelled_again.status == "cancelled"


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

    assert archil_module.create_sandbox(name="trial", wait=False) is expected
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
                "wait": False,
            },
        ),
        ("list", {"disk": "dsk-1"}),
        ("get", "sbx-1"),
    ]


@pytest.mark.asyncio
async def test_interactive_exec_pty(archil, router, monkeypatch):
    import archil._sandbox as sandbox_module

    socket = FakeWebSocket()
    connected_urls = []

    async def connect(url: str):
        connected_urls.append(url)
        return socket

    def handler(request):
        if request.url.path.endswith("/connections"):
            return ok_envelope({"url": "wss://sandbox.example/ws", "expires_at": NOW})
        return ok_envelope(sandbox_json())

    monkeypatch.setattr(sandbox_module, "_websocket_connect", connect)
    router.set(handler)
    sandbox = await archil.sandboxes.get.aio("sbx-1")
    output = []
    command = "echo 'hello' && codex"

    pty = await sandbox.exec.aio(
        command,
        pty=True,
        cols=120,
        rows=40,
        on_data=output.append,
    )
    assert isinstance(pty, SandboxPty)
    await socket.push("hello\n")
    await asyncio.sleep(0)
    await pty.send_input.aio("Review this repository\n")
    await pty.resize.aio(cols=160, rows=50)
    await socket.finish("process exited with code 17")

    result = await pty.wait.aio()
    assert result.exit_code == 17
    assert connected_urls == ["wss://sandbox.example/ws"]
    assert output == ["hello\n"]
    assert [json.loads(message) for message in socket.sent] == [
        {"type": "resize", "cols": 120, "rows": 40},
        {"type": "input", "data": f"eval {shlex.quote(command)}; exit $?\n"},
        {"type": "input", "data": "Review this repository\n"},
        {"type": "resize", "cols": 160, "rows": 50},
    ]


@pytest.mark.asyncio
async def test_interactive_exec_without_exit_status(archil, router, monkeypatch):
    import archil._sandbox as sandbox_module

    socket = FakeWebSocket()

    async def connect(_url: str):
        return socket

    router.set(
        lambda request: ok_envelope(
            {"url": "wss://sandbox.example/ws", "expires_at": NOW}
            if request.url.path.endswith("/connections")
            else sandbox_json()
        )
    )
    monkeypatch.setattr(sandbox_module, "_websocket_connect", connect)
    sandbox = await archil.sandboxes.get.aio("sbx-1")
    pty = await sandbox.exec.aio("codex", pty=True)
    await socket.finish("")

    assert (await pty.wait.aio()).exit_code is None


@pytest.mark.asyncio
async def test_interactive_exec_reports_connection_failure(archil, router, monkeypatch):
    import archil._sandbox as sandbox_module

    async def connect(_url: str):
        raise OSError("connection refused")

    router.set(
        lambda request: ok_envelope(
            {"url": "wss://sandbox.example/ws", "expires_at": NOW}
            if request.url.path.endswith("/connections")
            else sandbox_json()
        )
    )
    monkeypatch.setattr(sandbox_module, "_websocket_connect", connect)
    sandbox = await archil.sandboxes.get.aio("sbx-1")

    with pytest.raises(ConnectionError, match="Interactive exec connection failed"):
        await sandbox.exec.aio("codex", pty=True)
