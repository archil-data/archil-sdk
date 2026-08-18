# archil

Python client for [Archil](https://archil.com) disks and sandboxes. Create persistent disks and microVM sandboxes, run commands against them, and read/write disk contents through the S3-compatible object API — all from scripts, CI, or notebooks. It also ships **drop-in [agent tools](#agent-tools)** that turn a disk into a ready-made filesystem toolset for OpenAI Agents, LangChain, and other frameworks.

`archil` talks to the Archil control plane over HTTPS and has no native dependencies.

Every method works **both synchronously and asynchronously** from a single implementation: `disk.put_object(...)` blocks, while `disk.put_object.aio(...)` returns a coroutine you can `await`. This is powered by [`synchronicity`](https://github.com/modal-labs/synchronicity) — the same approach Modal uses — so there's one source of truth and no duplicated sync/async logic.

## Install

```bash
pip install archil
```

## Library

```python
import archil

# Configure once per process — falls back to ARCHIL_API_KEY / ARCHIL_REGION env vars.
archil.configure(api_key="key-...", region="aws-us-east-1")

# Create a disk. `token` here is the disk token — the one-time credential for mounting.
result = archil.create_disk(name="my-disk")
print(f"Created {result.disk.id}, disk token: {result.token}")

# A freshly-created disk starts in "creating"; block until it's usable.
disk = result.disk.wait_until_ready()  # raises on terminal failure / timeout

# List and look up disks
all_disks = archil.list_disks()
d = archil.get_disk(result.disk.id)
```

Per-disk operations are methods on the `Disk` object itself, not top-level functions:

```python
d = archil.get_disk("dsk-abc123")

# Run a command in a container with the disk mounted
res = d.exec("ls -la /mnt && cat /mnt/config.json")
print(res.stdout, res.stderr, res.exit_code)

# Manage who can mount the disk
from archil import TokenUser
user = d.add_user(TokenUser(nickname="ci"))
d.remove_user("token", user.identifier)

# Delete
d.delete()
```

### Sandboxes

Use `Archil.sandboxes` or the module-level helpers to manage persistent microVMs:

```python
sandbox = archil.create_sandbox(
    name="prepared-environment",
    vcpu_count=4,
    mem_size_mib=8192,
)

execution = sandbox.processes.start("uname -a")
result = execution.wait()
print(result.stdout)

# Existing API for durable control-plane exec records.
running_exec = sandbox.exec("sleep 60", wait=False)

sandbox.stop()
fork = sandbox.fork(name="agent-task")
connection = fork.create_connection()
fork.stop()
fork.delete()

all_sandboxes = archil.list_sandboxes()
using_disk = archil.list_sandboxes(disk="dsk-abc123")
```

Sandboxes support 1–32 vCPUs and 256–65,536 MiB of memory. When omitted,
`vcpu_count` defaults to 1 and `mem_size_mib` defaults to 2,048 MiB.

Runtime-owned processes return immediately and can be disconnected without
stopping the command. Reconnect by process ID and output cursor to continue
where the previous connection stopped:

```python
from archil import SandboxTerminal

process = sandbox.processes.start(
    "codex",
    terminal=SandboxTerminal(cols=120, rows=40),
    on_output=lambda output: print(output.data.decode(errors="replace"), end=""),
)
process.send_input("Review this repository\n")
process.resize(cols=160, rows=50)
process_id = process.id
cursor = process.cursor
process.disconnect()

resumed = sandbox.processes.connect(process_id, offset=cursor)
result = resumed.wait()
```

Terminal processes merge output into stdout; non-terminal processes keep
stdout and stderr separate. `on_output` receives raw bytes with their stream
and absolute offset. `close_stdin()` delivers EOF to a non-terminal process.
`send_input()` streams large writes as 1 MiB WebSocket frames. `disconnect()`
only closes the client connection; `kill()` terminates the process. Set
`collect_output=False` to stream through `on_output` without retaining decoded
output in the process handle or result. Resize and kill use separate one-shot
process controls, so they do not wait behind stdin. `kill()` returns after the
control is acknowledged; `wait()` observes exit. `max_concurrent_execs`
limits attached exec sessions; detached processes and one-shot controls do not
count. Pausing a sandbox disconnects attachments but preserves its processes
for reattachment after resume.
Processes end when their sandbox is stopped or expires. After reconnecting with
an offset, `wait().stdout` and `wait().stderr` contain the output received by
that handle from that offset, not output from before it. The existing `exec`
API remains available for durable control-plane exec records.

Transfer files directly between the local machine and a running sandbox:

```python
sandbox.files.upload_file("./input.tar.gz", "/workspace/input.tar.gz")
sandbox.files.download_file("/workspace/result.json", "./result.json")
```

Transfers stream through `sandbox.processes` rather than buffering the whole
file in memory. Downloads request one bounded chunk at a time; a short or empty
chunk marks end-of-file. Uploads and downloads replace their destination only
after the transfer succeeds.

`create`, `start`, `stop`, `pause`, `resume`, `fork`, and non-interactive
`exec` wait for completion by default. The server handles the initial wait; if
its wait budget expires first, the SDK continues polling. Pass `wait=False` to
return as soon as the operation is accepted.

### Delegations

A delegation grants a client exclusive write access to an inode on a shared
disk. List the delegations currently held on a disk and forcibly revoke one to
reclaim write access from a client that disconnected without checking it in:

```python
disk = archil.get_disk("dsk-abc123")

for delegation in disk.list_delegations():
    if delegation.is_orphaned:
        disk.revoke_delegation(delegation)
```

Delegations are identified by their `client_id` and `inode_id`. The `path` is
resolved best-effort by the server and may be `None`.

Account-level API keys are top-level helpers:

```python
archil.list_api_keys()
archil.create_api_key(name="ci-bot", description="GitHub Actions")
archil.delete_api_key("key-abc123")
```

### Reading and writing objects

A `Disk` doubles as an S3-compatible bucket: read, write, delete, and list its files by key without mounting it. These methods talk to Archil's S3 endpoint using your same API key (no separate S3 credentials or SigV4 signing on your part).

```python
import json
d = archil.get_disk("dsk-abc123")
report = {"generated": "2026-01", "rows": 1234}

# Write — accepts str or bytes. content_type is optional. Returns the etag.
result = d.put_object("reports/2026-01/data.json", json.dumps(report), "application/json")

# Read — returns bytes.
data = d.get_object("reports/2026-01/data.json")
text = data.decode("utf-8")

# Metadata / existence without downloading the body
meta = d.head_object("reports/2026-01/data.json")  # None if absent
if d.object_exists("reports/2026-01/data.json"):
    ...

# Delete (idempotent — deleting a missing key succeeds)
d.delete_object("reports/2026-01/data.json")
```

#### POSIX ownership and directories

Pass `uid`, `gid`, and `mode` when the files will be used by a non-root process:

```python
d.put_object(
    "path/a/b/file.txt",
    "hello",
    uid=1000,
    gid=1001,
    mode=0o640,
)
```

If `path/` already exists as `2000:2000 0700` and `a/` and `b/` are missing,
the resulting tree is:

| Path | Owner | Mode | Result |
| --- | --- | --- | --- |
| `path/` | `2000:2000` | `0700` | Existing directory; unchanged |
| `path/a/` | `1000:1001` | `0755` | Implicit parent created by the upload |
| `path/a/b/` | `1000:1001` | `0755` | Implicit parent created by the upload |
| `path/a/b/file.txt` | `1000:1001` | `0640` | Published file with the requested attributes |

The requested file mode never applies to implicit parents; they use `0755` so
they remain traversable. Existing directories are never re-owned or re-moded,
so in this example a FUSE process running as uid 1000 still cannot traverse the
pre-existing `path/` directory.

Create an explicit directory by putting an empty directory-marker key ending in
`/`:

```python
d.put_object(
    "path/a/private/",
    b"",
    uid=4000,
    gid=4001,
    mode=0o750,
)
```

This creates `private/` as `4000:4001 0750`. If the marker already exists, its
attributes are unchanged. When attributes are omitted, files default to
`root:root 0644` and directories to `root:root 0755`. Automatic multipart
uploads and append-created files use the same directory rules.

The disk **root** itself defaults to `root:root 0755`, which means an
unprivileged process cannot create entries directly under the mount root. To
avoid a post-mount `chown`, set the root's owner and mode when creating the
disk (creation-time only; a later `chown`/`chmod` through a mount changes the
live attributes as usual):

```python
from archil import RootAttrs

result = archil.create_disk(
    name="my-disk",
    root_attrs=RootAttrs(uid=1000, gid=1000, mode=0o755),
)
```

`mode` is octal (pass `0o750`, not `750`). On regions that don't support
`rootAttrs` yet the field is ignored and the disk is created with the
defaults — check the `rootAttrs` field on the created disk to confirm it
was applied.

`rootAttrs` only sets the root directory itself — it does not change how
later writes get their attributes:

- **Through a mount**, normal POSIX rules apply: entries are owned by the
  creating process's uid/gid, with mode derived from its umask. A process
  running as the `rootAttrs` uid therefore owns everything it creates, with
  no attributes to pass anywhere.
- **Through `putObject` and friends**, omitted attributes still mean the
  server defaults (`root:root 0644` files, `root:root 0755` directories) —
  the disk's `rootAttrs` is *not* used as a fallback. Keep passing
  `uid`/`gid` on object writes when a non-root process will read them.

`list_objects` auto-paginates by default, returning every matching key. The first argument is a key prefix; a non-recursive listing (the default) returns the immediate level as `objects` plus subdirectory `common_prefixes`:

```python
result = d.list_objects("reports/")                       # one level
all_keys = d.list_objects("reports/", recursive=True)     # whole subtree
first_100 = d.list_objects("reports/", limit=100)         # cap the total

# Stream pages instead of buffering everything (large listings):
for page in d.list_objects_pages("reports/"):
    for obj in page.objects:
        print(obj.key, obj.size, obj.last_modified)

# Or drive pagination yourself:
page = d.list_objects("reports/", single_page=True)
if page.is_truncated:
    nxt = d.list_objects("reports/", single_page=True, continuation_token=page.next_continuation_token)
```

### Large uploads and bulk delete

`put_object` handles any size with one call. Small bodies go through a single request; large ones are uploaded as a multipart upload automatically — split into parts, uploaded with bounded concurrency, and assembled, aborting the upload if any part fails so nothing is left half-staged. You don't pick a different method for big files. For very large objects the part size is grown automatically so the upload never exceeds S3's 10,000-part limit.

```python
# Small or multi-gigabyte — same call.
d.put_object("reports/2026-01/data.json", json.dumps(report), "application/json")

result = d.put_object(
    "backups/2026-01.tar",
    big_bytes,
    content_type="application/x-tar",
    multipart_threshold=5 * 1024 * 1024,  # switch to multipart above 5 MiB; default = part_size
    part_size=32 * 1024 * 1024,           # >= 5 MiB; default 16 MiB
    concurrency=8,                        # parts in flight at once; default 4
)
print(result.etag)
```

For manual control over the multipart lifecycle (e.g. uploading parts from separate processes), the raw S3 primitives live in the opt-in `d.multipart` namespace — `create`, `upload_part`, `complete`, `abort`, `list_parts`, `list_uploads`. Most code never needs these.

```python
upload = d.multipart.create("big.bin")
p1 = d.multipart.upload_part("big.bin", upload.upload_id, 1, first_chunk)
p2 = d.multipart.upload_part("big.bin", upload.upload_id, 2, second_chunk)
d.multipart.complete("big.bin", upload.upload_id, [p1, p2])
```

`delete_objects` removes many keys in one round trip (auto-batched at S3's 1000-key limit). Unlike `delete_object`, per-key failures are returned rather than raised:

```python
result = d.delete_objects(["a.txt", "logs/b.txt", "c.txt"])
for e in result.errors:
    print(f"{e.key}: {e.code} {e.message}")
```

`append_object` appends bytes to an existing object (creating it if absent) — handy for log-style writes. Each call may append at most 1 MiB; append in chunks to grow past that.

```python
d.append_object("logs/app.log", "first line\n")
d.append_object("logs/app.log", "second line\n")  # concatenated
```

Transient failures (HTTP 429 and 5xx, plus network errors) are retried automatically with jittered exponential backoff before surfacing; caller errors (other 4xx) are not retried. The two non-idempotent operations — `complete` (multipart) and `append_object` — are *not* auto-retried, since a retry after a succeeded-but-unacknowledged call would return a spurious `NoSuchUpload` (complete) or duplicate the appended bytes (append).

Failures raise `ArchilS3Error` with `status` (HTTP status), `code` (the S3 error code, e.g. `"NoSuchKey"`), `request_id`, and the raw body on `raw`. `get_object` on a missing key raises a 404 — use `head_object` / `object_exists` to probe without catching. All SDK errors extend `ArchilError`, so `except ArchilError` handles control-plane and S3 failures uniformly.

The S3 endpoint is derived from your region automatically. To target a custom environment, pass `s3_base_url` to `Archil(...)` (or set the `ARCHIL_S3_BASE_URL` env var).

### Sharing files

`share` mints a signed, time-limited link to a single file. Anyone with the link can download that file — no API key, no mounting. The link carries a cryptographically signed token (disk + key + expiry); when it expires it stops working.

```python
d = archil.get_disk("dsk-abc123")

# Default lifetime is 24 hours.
link = d.share("reports/2026-01/summary.pdf")
print(link.url)         # https://control.…/api/shared/<token>
print(link.expires_in)  # 86400

# Set the lifetime in seconds (any positive integer, up to 604800 = 7 days):
week_link = d.share("reports/2026-01/summary.pdf", expires_in=604800)
```

### Async

Every method on `Archil`, `Disks`, `Disk`, `Sandboxes`, `Sandbox`, and `Tokens` has an `.aio` variant that returns a coroutine. (The module-level helpers — `configure`, `create_disk`, `create_sandbox`, etc. — are synchronous convenience wrappers; from async code, construct `Archil(...)` directly and use `.aio`.) Construct the client directly and `await`:

```python
import asyncio
from archil import Archil

async def main():
    async with Archil(api_key="key-...", region="aws-us-east-1") as client:
        d = await client.disks.get.aio("dsk-abc123")
        await d.put_object.aio("a/b.txt", b"hello")
        data = await d.get_object.aio("a/b.txt")
        async for page in d.list_objects_pages.aio("a/"):
            for obj in page.objects:
                print(obj.key)

asyncio.run(main())
```

### Multiple accounts or regions

For multi-tenant scripts, instantiate `Archil` directly instead of using the module-level `configure`:

```python
from archil import Archil

prod = Archil(api_key=prod_key, region="aws-us-east-1")
staging = Archil(api_key=staging_key, region="aws-us-east-1")

prod_disks = prod.disks.list()
staging_disks = staging.disks.list()
```

## Agent tools

Turn a disk — or a multi-disk **workspace** — into a ready-made filesystem toolset for popular agent frameworks, so you can hand an LLM a real filesystem to work in. The agent gets six tools: `read_file`, `write_file`, `delete_file`, `list_files`, `grep`, and `run_bash` (an arbitrary command in a container with the disk mounted).

```python
import archil
from agents import Agent  # OpenAI Agents SDK

d = archil.get_disk("dsk-abc123")

# Single disk → tools for your framework. The disk is the filesystem root (/).
agent = Agent(name="assistant", tools=d.agent_tools().for_openai_agents())
```

Or span several disks in one **workspace** (the same shape as `exec`'s mounts). Each disk is a top-level directory (e.g. `/data/…`, `/cache/…`); file operations route to the right disk by path, and `grep` / `list_files` fan out across all of them. `run_bash` starts at the common root, so relative paths line up:

```python
ws = archil.workspace({
    "data": archil.get_disk("dsk-data"),
    "cache": archil.get_disk("dsk-cache"),
})
tools = ws.agent_tools().for_langchain()  # LangChain / LangGraph
```

A `Workspace` is a full filesystem in its own right — the same object API a `Disk` has (`get_object` / `put_object` / `delete_object` / `list_objects` / `grep` / `exec`; both satisfy the `FileSystem` protocol), so you can use it directly without the agent tools, and add or remove disks at runtime with `ws.add_disk(name, disk)` / `ws.remove_disk(name)`. A workspace's keys carry the disk name as their first segment:

```python
data = ws.get_object("data/reports/q1.csv")         # routes to the "data" disk
ws.add_disk("scratch", archil.get_disk("dsk-tmp"))  # mount another disk live
```

Pick the adapter for your framework — each returns that framework's native tool objects:

| Method | Framework | Returns |
| --- | --- | --- |
| `.for_openai_agents()` | OpenAI Agents SDK | `list[FunctionTool]` |
| `.for_langchain()` | LangChain / LangGraph | `list[StructuredTool]` |

Frameworks are optional — install the matching extra:

```bash
pip install "archil[openai-agents]"   # OpenAI Agents SDK
pip install "archil[langchain]"       # LangChain / LangGraph
```

Expose a subset of tools with `tools=[...]` (e.g. read-only research: `d.agent_tools(tools=["read_file", "list_files", "grep"])`). To give an agent read-only access to a disk in a workspace, mount it with `ExecMountSpec(disk=d, read_only=True)` — `write_file` / `delete_file` then return an error instead of mutating it.

## Connecting to a disk's data plane

To run a command against a disk, use `Disk.exec()` — it returns stdout, stderr, and an exit code from an Archil-managed container with the disk pre-mounted. No local filesystem involved.

To mount a disk as a real filesystem on your machine, use the [`archil`](https://archil.com) CLI — it mounts through the OS kernel via FUSE, so any program can read and write files with standard APIs. Mounting from Python is not supported; use `exec()` or the S3-compatible object API instead.

## Supported regions

| Region            | Provider |
| ----------------- | -------- |
| `aws-us-east-1`   | AWS      |
| `aws-us-west-2`   | AWS      |
| `aws-eu-west-1`   | AWS      |
| `gcp-us-central1` | GCP      |

## FAQ

### What's the difference between an API key and a disk token?

- **API key** — account-level credential for the control plane. You use one whenever you call `archil`. Create and manage them at [console.archil.com](https://console.archil.com). Goes in the `ARCHIL_API_KEY` env var or the `api_key` argument.
- **Disk token** — per-disk credential that lets a client mount a specific disk. Created automatically when you `create_disk(...)` (the value is shown once; save it).

## Support

Questions, feature requests, or issues? Reach us at **support@archil.com**.
