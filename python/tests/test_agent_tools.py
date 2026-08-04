from __future__ import annotations

import json
from urllib.parse import unquote

import httpx
import pytest

from archil import Archil, ExecMountSpec


def _disk_json(disk_id: str, name: str) -> dict:
    return {
        "id": disk_id,
        "name": name,
        "organization": "org-1",
        "status": "available",
        "provider": "aws",
        "region": "aws-us-east-1",
        "createdAt": "2026-01-01T00:00:00Z",
    }


def _exec_envelope(stdout: str = "", stderr: str = "", exit_code: int = 0) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "success": True,
            "data": {
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "timing": {"totalMs": 10, "queueMs": 1, "executeMs": 9},
            },
        },
    )


def _grep_envelope(
    matches: list[dict], files_scanned: int = 1, stopped_reason: str = "completed"
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "success": True,
            "data": {
                "matches": matches,
                "stoppedReason": stopped_reason,
                "filesScanned": files_scanned,
                "containersDispatched": 1,
                "computeSecondsUsed": 0.1,
                "durationMs": 5,
                "listingMs": 1,
                "grepMs": 4,
            },
        },
    )


def _list_xml(keys: dict[str, bytes], prefix: str, delimiter: str | None) -> str:
    contents = ""
    common = set()
    for key in sorted(keys):
        if prefix and not key.startswith(prefix):
            continue
        rest = key[len(prefix):]
        if delimiter and delimiter in rest:
            common.add(prefix + rest.split(delimiter, 1)[0] + delimiter)
            continue
        contents += f"<Contents><Key>{key}</Key><Size>{len(keys[key])}</Size></Contents>"
    cps = "".join(f"<CommonPrefixes><Prefix>{p}</Prefix></CommonPrefixes>" for p in sorted(common))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<ListBucketResult><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated>"
        f"<Prefix>{prefix}</Prefix>{contents}{cps}</ListBucketResult>"
    )


class FakeFleet:
    """In-memory control-plane + S3 store routed through MockTransport, so the
    agent tools exercise the real SDK transport, routing, and handlers."""

    def __init__(self) -> None:
        # disk_id -> { key -> bytes }
        self.disks: dict[str, dict[str, bytes]] = {"dsk-1": {}, "dsk-2": {}}
        self.disk_names = {"dsk-1": "alpha", "dsk-2": "beta"}
        self.exec_calls: list[dict] = []
        self.grep_calls: list[dict] = []
        self.grep_stopped_reason = "completed"
        self.fail_list_for: set[str] = set()  # disk ids whose ListObjects should 500

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.url.host == "cp.test":
            return self._control_plane(req)
        return self._s3(req)

    def _control_plane(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/api/exec":
            self.exec_calls.append(json.loads(req.content))
            return _exec_envelope(stdout="ran in workspace")
        if path.endswith("/exec"):
            disk_id = path.split("/")[3]
            self.exec_calls.append({"disk": disk_id, "body": json.loads(req.content)})
            return _exec_envelope(stdout=f"ran on {disk_id}")
        if path.endswith("/grep"):
            disk_id = path.split("/")[3]
            body = json.loads(req.content)
            self.grep_calls.append({"disk": disk_id, "body": body})
            store = self.disks[disk_id]
            matches = [
                {"file": k, "line": 1, "text": v.decode("utf-8", "replace")}
                for k, v in store.items()
                if body["pattern"] in v.decode("utf-8", "replace")
            ]
            return _grep_envelope(
                matches, files_scanned=len(store), stopped_reason=self.grep_stopped_reason
            )
        # GET /api/disks/{id}
        disk_id = path.split("/")[-1]
        return httpx.Response(200, json={"success": True, "data": _disk_json(disk_id, self.disk_names[disk_id])})

    def _s3(self, req: httpx.Request) -> httpx.Response:
        disk_id = req.url.path.split("/")[1]
        store = self.disks[disk_id]
        key = unquote(req.url.path[len(f"/{disk_id}"):].lstrip("/"))
        if req.method == "PUT":
            store[key] = req.content
            return httpx.Response(200, headers={"etag": '"abc"'})
        if req.method == "DELETE":
            store.pop(key, None)
            return httpx.Response(204)
        if req.method == "GET" and key == "":
            if disk_id in self.fail_list_for:
                return httpx.Response(500, content=b"<Error><Code>InternalError</Code></Error>")
            prefix = req.url.params.get("prefix", "") or ""
            delimiter = req.url.params.get("delimiter")
            return httpx.Response(200, content=_list_xml(store, prefix, delimiter).encode())
        if req.method in ("GET", "HEAD"):
            if key not in store:
                body = "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>"
                return httpx.Response(404, content=body.encode())
            return httpx.Response(200, content=store[key])
        return httpx.Response(400)


@pytest.fixture
def fleet() -> FakeFleet:
    return FakeFleet()


@pytest.fixture
def client(fleet: FakeFleet) -> Archil:
    return Archil(
        api_key="key-test",
        region="aws-us-east-1",
        base_url="http://cp.test",
        s3_base_url="http://s3.test",
        _http_transport=httpx.MockTransport(fleet),
    )


def _tool(target, name):
    # Accept either a bound toolset or a filesystem (Disk/Workspace) to build one.
    toolset = target if hasattr(target, "tools") else target.agent_tools()
    return next(t for t in toolset.tools if t.name == name)


def test_tool_set_names(client):
    toolset = client.disks.get("dsk-1").agent_tools()
    assert {t.name for t in toolset.tools} == {
        "read_file",
        "write_file",
        "delete_file",
        "list_files",
        "grep",
        "run_bash",
    }


def test_tool_subset_selection(client):
    toolset = client.disks.get("dsk-1").agent_tools(tools=["read_file", "write_file"])
    assert {t.name for t in toolset.tools} == {"read_file", "write_file"}


def test_unknown_tool_name_raises(client):
    with pytest.raises(ValueError):
        client.disks.get("dsk-1").agent_tools(tools=["nope"])


async def test_single_disk_write_then_read(client, fleet):
    toolset = client.disks.get("dsk-1").agent_tools()
    write = _tool(toolset, "write_file")
    read = _tool(toolset, "read_file")

    msg = await write.invoke({"path": "/notes/todo.txt", "content": "hello"})
    assert "Wrote" in msg
    # The disk is rooted at /, so /notes/todo.txt maps to the key notes/todo.txt.
    assert fleet.disks["dsk-1"]["notes/todo.txt"] == b"hello"

    assert await read.invoke({"path": "/notes/todo.txt"}) == "hello"
    # A bare relative path resolves the same against the single disk.
    assert await read.invoke({"path": "notes/todo.txt"}) == "hello"


async def test_read_missing_file_returns_error(client):
    read = _tool(client.disks.get("dsk-1").agent_tools(), "read_file")
    out = await read.invoke({"path": "/missing.txt"})
    assert "not found" in out.lower()


async def test_workspace_unknown_disk_is_rejected(client):
    # In a workspace the first path segment names the disk; an unknown one errors.
    ws = client.workspace({"data": client.disks.get("dsk-1")})
    out = await _tool(ws, "read_file").invoke({"path": "/nope/x.txt"})
    assert out.startswith("Error:") and "no disk named" in out.lower()


async def test_recursive_string_false_is_respected(client, fleet):
    grep = _tool(client.disks.get("dsk-1").agent_tools(), "grep")
    await grep.invoke({"pattern": "x", "recursive": "false"})
    # "false" must not be coerced to True via truthiness.
    assert fleet.grep_calls[-1]["body"]["recursive"] is False


async def test_grep_string_max_results_is_coerced(client, fleet):
    grep = _tool(client.disks.get("dsk-1").agent_tools(), "grep")
    await grep.invoke({"pattern": "x", "max_results": "50"})
    assert fleet.grep_calls[-1]["body"]["maxResults"] == 50


async def test_grep_single_disk_directory_is_normalized(client, fleet):
    # "/reports" must reach the grep API as the disk-relative key "reports",
    # matching how read_file/write_file/list_files normalize the same path.
    grep = _tool(client.disks.get("dsk-1").agent_tools(), "grep")
    await grep.invoke({"pattern": "x", "path": "/reports"})
    assert fleet.grep_calls[-1]["body"]["directory"] == "reports"


def test_workspace_remove_last_disk_is_refused(client):
    ws = client.workspace({"data": client.disks.get("dsk-1")})
    with pytest.raises(ValueError, match="last disk"):
        ws.remove_disk("data")
    assert ws.disk_names() == ["data"]


async def test_workspace_list_files_root_shows_disks_not_contents(client, fleet):
    fleet.disks["dsk-1"]["deep/file.txt"] = b"x"
    ws = client.workspace({"data": client.disks.get("dsk-1"), "cache": client.disks.get("dsk-2")})
    out = await _tool(ws, "list_files").invoke({"path": "/"})
    assert "dir   /data/" in out
    assert "dir   /cache/" in out
    # A non-recursive root listing names the disks; it doesn't recurse into them.
    assert "file.txt" not in out


async def test_list_files_warns_when_a_workspace_disk_listing_fails(client, fleet):
    # A disk that errors during fan-out flips is_truncated; list_files must warn
    # rather than present the partial listing as complete.
    fleet.fail_list_for.add("dsk-2")
    fleet.disks["dsk-1"]["a.txt"] = b"x"
    ws = client.workspace({"data": client.disks.get("dsk-1"), "cache": client.disks.get("dsk-2")})
    # Recursive, so the listing fans out into the disks (where dsk-2 then fails).
    out = await _tool(ws, "list_files").invoke({"path": "/", "recursive": True})
    assert "/data/a.txt" in out  # the disk that succeeded is still listed
    assert "incomplete" in out.lower()


async def test_grep_failed_listing_surfaces_partial_warning(client, fleet):
    fleet.disks["dsk-1"]["hit.txt"] = b"needle"
    fleet.grep_stopped_reason = "list_failed"
    grep = _tool(client.disks.get("dsk-1").agent_tools(), "grep")
    out = await grep.invoke({"pattern": "needle"})
    assert "needle" in out
    assert "partial" in out.lower() or "incomplete" in out.lower()


async def test_run_bash_single_disk(client, fleet):
    run = _tool(client.disks.get("dsk-1").agent_tools(), "run_bash")
    out = await run.invoke({"command": "echo hi"})
    assert "ran on dsk-1" in out
    assert fleet.exec_calls[-1]["disk"] == "dsk-1"


async def test_workspace_routes_by_path(client, fleet):
    ws = client.workspace({"data": client.disks.get("dsk-1"), "cache": client.disks.get("dsk-2")})
    write = _tool(ws, "write_file")

    await write.invoke({"path": "/data/a.txt", "content": "A"})
    await write.invoke({"path": "/cache/b.txt", "content": "B"})

    assert fleet.disks["dsk-1"]["a.txt"] == b"A"
    assert fleet.disks["dsk-2"]["b.txt"] == b"B"


async def test_workspace_grep_fans_out(client, fleet):
    fleet.disks["dsk-1"]["a.txt"] = b"needle here"
    fleet.disks["dsk-2"]["b.txt"] = b"needle there"
    ws = client.workspace({"data": client.disks.get("dsk-1"), "cache": client.disks.get("dsk-2")})
    out = await _tool(ws, "grep").invoke({"pattern": "needle"})
    # Both disks were searched and matches carry disk-rooted paths.
    assert "/data/a.txt" in out
    assert "/cache/b.txt" in out
    assert {c["disk"] for c in fleet.grep_calls} == {"dsk-1", "dsk-2"}


async def test_workspace_run_bash_mounts_all(client, fleet):
    ws = client.workspace({"data": client.disks.get("dsk-1"), "cache": client.disks.get("dsk-2")})
    out = await _tool(ws, "run_bash").invoke({"command": "ls"})
    assert "ran in workspace" in out
    assert set(fleet.exec_calls[-1]["disks"]) == {"data", "cache"}


async def test_read_only_mount_blocks_writes(client, fleet):
    ws = client.workspace(
        {"data": ExecMountSpec(disk=client.disks.get("dsk-1"), read_only=True)}
    )
    out = await _tool(ws, "write_file").invoke({"path": "/data/x.txt", "content": "x"})
    assert "read-only" in out.lower()
    assert "x.txt" not in fleet.disks["dsk-1"]


def test_workspace_rejects_disk_id_strings(client):
    with pytest.raises(ValueError):
        client.workspace({"data": "dsk-1"})


def test_workspace_rejects_nested_mount_names(client):
    with pytest.raises(ValueError):
        client.workspace({"a/b": client.disks.get("dsk-1")})


def test_disk_and_workspace_satisfy_filesystem(client):
    # The shared FileSystem contract is what keeps Disk and Workspace from
    # drifting; both must satisfy it (runtime_checkable checks method presence).
    from archil import FileSystem

    assert isinstance(client.disks.get("dsk-1"), FileSystem)
    assert isinstance(client.workspace({"data": client.disks.get("dsk-1")}), FileSystem)


def test_disk_filesystem_methods_blocking(client, fleet):
    # The disk satisfies FileSystem via its existing object API — no new methods.
    disk = client.disks.get("dsk-1")
    disk.put_object("notes/x.txt", "hi")
    assert fleet.disks["dsk-1"]["notes/x.txt"] == b"hi"
    assert disk.get_object("notes/x.txt") == b"hi"


def test_workspace_filesystem_blocking(client, fleet):
    # The wrapped Workspace routes through its impl disks on the background loop;
    # exercise the blocking path to guard that bridging. Keys carry the disk name.
    ws = client.workspace({"data": client.disks.get("dsk-1")})
    ws.put_object("data/s.txt", "sync")
    assert fleet.disks["dsk-1"]["s.txt"] == b"sync"
    assert ws.get_object("data/s.txt") == b"sync"


async def test_workspace_filesystem_async(client, fleet):
    ws = client.workspace(
        {"data": client.disks.get("dsk-1"), "cache": client.disks.get("dsk-2")}
    )
    await ws.put_object.aio("data/a.txt", "A")
    assert fleet.disks["dsk-1"]["a.txt"] == b"A"
    assert await ws.get_object.aio("data/a.txt") == b"A"
    # A non-recursive root listing names the disks; recursive fans out into them.
    root = await ws.list_objects.aio()
    assert sorted(root.common_prefixes) == ["cache/", "data/"]
    listing = await ws.list_objects.aio(recursive=True)
    assert any(o.key == "data/a.txt" for o in listing.objects)
    await ws.delete_object.aio("data/a.txt")
    assert "a.txt" not in fleet.disks["dsk-1"]


async def test_workspace_add_remove_disk_runtime(client, fleet):
    ws = client.workspace({"data": client.disks.get("dsk-1")})
    assert ws.disk_names() == ["data"]
    ws.add_disk("cache", client.disks.get("dsk-2"))
    assert sorted(ws.disk_names()) == ["cache", "data"]
    await ws.put_object.aio("cache/c.txt", "C")
    assert fleet.disks["dsk-2"]["c.txt"] == b"C"
    assert ws.remove_disk("cache") is True
    out = await _tool(ws, "read_file").invoke({"path": "/cache/x.txt"})
    assert "no disk named" in out.lower()


async def test_workspace_run_bash_preserves_conditional(client, fleet):
    ws = client.workspace({"data": ExecMountSpec(disk=client.disks.get("dsk-1"), conditional=True)})
    await _tool(ws, "run_bash").invoke({"command": "ls"})
    assert fleet.exec_calls[-1]["disks"]["data"]["conditional"] is True


async def test_grep_max_results_ignores_booleans(client, fleet):
    grep = _tool(client.disks.get("dsk-1").agent_tools(), "grep")
    # int(True) == 1 in Python; a bool must fall back to the default, not cap at 1.
    await grep.invoke({"pattern": "x", "max_results": True})
    assert fleet.grep_calls[-1]["body"]["maxResults"] == 200


async def test_handler_errors_are_returned_not_raised():
    # The contract is "errors are returned, not thrown" — an unexpected exception
    # in a handler becomes a readable tool result so the agent can recover.
    from archil.agent_tools import BoundTool

    async def boom(_ctx, _args):
        raise RuntimeError("unexpected boom")

    tool = BoundTool(name="x", description="d", parameters={}, context=None, handler=boom)
    assert await tool.invoke({}) == "Error: unexpected boom"


async def test_langchain_accepts_string_recursive_and_max_results(client, fleet):
    # The JSON schema must allow string forms or StructuredTool validation rejects
    # them before the handler's _as_bool/_as_int coercion runs.
    pytest.importorskip("langchain_core")
    tools = {t.name: t for t in client.disks.get("dsk-1").agent_tools().for_langchain()}
    await tools["grep"].ainvoke({"pattern": "x", "recursive": "false", "max_results": "50"})
    assert fleet.grep_calls[-1]["body"]["recursive"] is False
    assert fleet.grep_calls[-1]["body"]["maxResults"] == 50


async def test_openai_adapter_malformed_json_returns_error(client):
    pytest.importorskip("agents")
    tools = {t.name: t for t in client.disks.get("dsk-1").agent_tools().for_openai_agents()}
    out = await tools["read_file"].on_invoke_tool(None, "{not valid json")
    assert "could not parse" in out.lower()


def test_openai_agents_adapter_shapes_tools(client):
    pytest.importorskip("agents")
    tools = client.disks.get("dsk-1").agent_tools().for_openai_agents()
    assert {t.name for t in tools} == {
        "read_file",
        "write_file",
        "delete_file",
        "list_files",
        "grep",
        "run_bash",
    }
    assert all(t.params_json_schema["type"] == "object" for t in tools)


def test_langchain_adapter_shapes_tools(client):
    pytest.importorskip("langchain_core")
    tools = client.disks.get("dsk-1").agent_tools().for_langchain()
    assert {t.name for t in tools} == {
        "read_file",
        "write_file",
        "delete_file",
        "list_files",
        "grep",
        "run_bash",
    }


async def test_openai_agents_loop_drives_our_tool(client, fleet):
    """A scripted mock Model emits a write_file tool call; the real Runner loop
    routes it to our FunctionTool, which writes to the (mocked) disk."""
    pytest.importorskip("agents")
    import json as _json

    from agents import Agent, Model, ModelResponse, Runner, Usage
    from openai.types.responses import (
        ResponseFunctionToolCall,
        ResponseOutputMessage,
        ResponseOutputText,
    )

    tool_call = ResponseFunctionToolCall(
        type="function_call",
        call_id="c1",
        name="write_file",
        arguments=_json.dumps({"path": "/agent.txt", "content": "by openai agent"}),
    )
    final = ResponseOutputMessage(
        id="m1",
        type="message",
        role="assistant",
        status="completed",
        content=[ResponseOutputText(type="output_text", text="done", annotations=[])],
    )

    class FakeModel(Model):
        def __init__(self) -> None:
            self._i = 0

        async def get_response(self, *args, **kwargs) -> ModelResponse:
            self._i += 1
            output = [tool_call] if self._i == 1 else [final]
            return ModelResponse(output=output, usage=Usage(), response_id=None, request_id=None)

        async def stream_response(self, *args, **kwargs):
            raise NotImplementedError
            yield  # pragma: no cover - marks this an async generator, never run

    agent = Agent(
        name="t",
        instructions="write files when asked",
        model=FakeModel(),
        tools=client.disks.get("dsk-1").agent_tools().for_openai_agents(),
    )
    await Runner.run(agent, "write the file")
    assert fleet.disks["dsk-1"]["agent.txt"] == b"by openai agent"


async def test_langchain_tool_call_drives_our_tool(client, fleet):
    """A LangChain chat model's emitted tool call, fed to our StructuredTool via
    the real ainvoke protocol, executes against the (mocked) disk."""
    pytest.importorskip("langchain_core")
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    tools = {t.name: t for t in client.disks.get("dsk-1").agent_tools().for_langchain()}
    model = GenericFakeChatModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "write_file",
                            "args": {"path": "/lc.txt", "content": "by langchain"},
                            "id": "call1",
                            "type": "tool_call",
                        }
                    ],
                )
            ]
        )
    )
    # GenericFakeChatModel replays the scripted message regardless of bind_tools
    # (which it doesn't implement), so invoke it directly to get the tool call.
    ai = model.invoke("write the file")
    assert ai.tool_calls, "fake model did not emit a tool call"
    for tc in ai.tool_calls:
        msg = await tools[tc["name"]].ainvoke(tc)  # StructuredTool.ainvoke(ToolCall) -> ToolMessage
        assert "Wrote" in msg.content
    assert fleet.disks["dsk-1"]["lc.txt"] == b"by langchain"
