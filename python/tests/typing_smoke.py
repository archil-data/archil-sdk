"""Type-checking smoke file — exercised by mypy and pyright in CI, not by pytest.

Imports the public API the way the README does and calls the headline operations,
so a regression in the type stubs (e.g. a generated __init__.pyi re-declaring
models, or a list/Sequence variance change) fails CI instead of shipping broken
types to users. Runtime is never executed; only static analysis matters here.
"""

import asyncio
from typing import Optional
import archil
from archil import (
    AgentToolset,
    Archil,
    ArchilS3Error,
    Delegation,
    FileSystem,
    S3CompatibleMount,
    S3Mount,
    Sandbox,
    SandboxEgressPolicy,
    SandboxNetwork,
    SandboxProcess,
    SandboxProcessOutput,
    SandboxProcessResult,
    SandboxTerminal,
    TokenUser,
    Workspace,
)


def sync_usage() -> None:
    archil.configure(api_key="key-x", region="aws-us-east-1")
    result = archil.create_disk(name="d", mounts=[S3Mount(bucket_name="b")])
    disk = result.disk
    _id: str = disk.id

    client = Archil(api_key="key-x", region="aws-us-east-1")
    sandbox: Sandbox = client.sandboxes.create(
        name="trial",
        vcpu_count=2,
        mem_size_mib=4096,
        base_image="docker:29.7.1-dind",
        network=SandboxNetwork(
            egress=SandboxEgressPolicy(default="deny", allow=["github.com", "*.github.com"])
        ),
    )
    _network: Optional[SandboxNetwork] = sandbox.network
    module_sandbox: Sandbox = archil.create_sandbox(name="trial")
    _module_sandboxes: list[Sandbox] = archil.list_sandboxes()
    module_sandbox = archil.get_sandbox(module_sandbox.id)
    sandbox_result: SandboxProcessResult = sandbox.exec("echo ready")
    _sandbox_exit: Optional[int] = sandbox_result.exit_code
    sandbox.files.upload_file("local.txt", "/workspace/remote.txt", mode=0o640)
    sandbox.files.download_file("/workspace/remote.txt", "downloaded.txt")
    process: SandboxProcess = sandbox.processes.start(
        "codex",
        terminal=SandboxTerminal(cols=120, rows=40),
        on_output=consume_process_output,
        collect_output=False,
    )
    process.send_input(b"Review this repository\n")
    cursor: int = process.cursor
    process.disconnect()
    resumed = sandbox.processes.connect(process.id, offset=cursor)
    resumed.kill()
    sandbox.stop().delete()
    created = client.disks.create(
        name="d2",
        mounts=[
            S3CompatibleMount(bucket_name="b", bucket_endpoint="http://e", access_key_id="ak", secret_access_key="sk")
        ],
    )
    d = client.disks.get(created.disk.id)
    d = d.wait_until_ready(timeout=60)
    d = d.refresh()
    if d.status == "available":  # DiskStatus literal — typos would be a type error
        pass
    user = d.add_user(TokenUser(nickname="ci"))
    d.remove_user("token", user.identifier or "")
    delegations: list[Delegation] = d.list_delegations()
    if delegations:
        d.revoke_delegation(delegations[0])
    put = d.put_object("k", b"x")
    _etag = put.etag
    share = d.share("reports/data.pdf", expires_in=604800)
    _url: str = share.url
    _expires: int = share.expires_in
    body: bytes = d.get_object("k")
    _ = body
    meta = d.head_object("k")
    if meta is not None:
        _size: int = meta.size
    listing = client.disks.get(created.disk.id).list_objects("prefix/")
    for obj in listing.objects:
        _k: str = obj.key
    try:
        d.get_object("missing")
    except ArchilS3Error as e:
        _status: int = e.status


async def async_usage() -> None:
    async with Archil(api_key="key-x", region="aws-us-east-1") as client:
        sandbox = await client.sandboxes.create.aio(name="trial")
        result: SandboxProcessResult = await sandbox.exec.aio("echo ready")
        _sandbox_exit: Optional[int] = result.exit_code
        await sandbox.files.upload_file.aio("local.txt", "/workspace/remote.txt")
        await sandbox.files.download_file.aio("/workspace/remote.txt", "downloaded.txt")
        await (await sandbox.stop.aio()).delete.aio()
        process = await sandbox.processes.start.aio("cat")
        await process.close_stdin.aio()
        _process_result = await process.wait.aio()
        d = await client.disks.get.aio("dsk-1")
        await d.put_object.aio("k", b"y")
        data: bytes = await d.get_object.aio("k")
        _ = data
        share = await d.share.aio("reports/data.pdf")
        _url: str = share.url
        delegations: list[Delegation] = await d.list_delegations.aio()
        if delegations:
            await d.revoke_delegation.aio(delegations[0])
        async for page in d.list_objects_pages.aio("p/"):
            for obj in page.objects:
                _k: str = obj.key


def consume_process_output(output: SandboxProcessOutput) -> None:
    _stream: str = output.stream
    _data: bytes = output.data


def agent_tools_usage() -> None:
    client = Archil(api_key="key-x", region="aws-us-east-1")
    d = client.disks.get("dsk-1")

    # Single disk -> AgentToolset, then the per-framework adapters.
    toolset: AgentToolset = d.agent_tools()
    _bound = toolset.tools
    _oai = toolset.for_openai_agents()
    _lc = toolset.for_langchain()

    # A Disk is itself a FileSystem.
    fs: FileSystem = d

    # Multi-disk workspace, via the module-level helper and the client method.
    ws: Workspace = archil.workspace({"data": d})
    ws2: Workspace = client.workspace({"data": d, "logs": d})
    ws.add_disk("extra", d)
    _removed: bool = ws.remove_disk("extra")
    _names: list[str] = ws.disk_names()
    # A Workspace is a FileSystem and builds agent tools just like a Disk.
    fs2: FileSystem = ws
    _tools = (ws.agent_tools().for_langchain(), ws2.agent_tools().for_openai_agents())

    # FileSystem operations resolve on both (blocking form here). A single disk's
    # keys are disk-relative; a workspace's carry the disk name as first segment.
    _data: bytes = fs.get_object("reports/q1.csv")
    fs2.put_object("data/out.txt", "hello")
    listing = fs2.list_objects("data/", recursive=True)
    _first_key: str = listing.objects[0].key


def _unused() -> None:
    asyncio.run(async_usage())
    sync_usage()
    agent_tools_usage()
