"""The six filesystem tools, defined once.

Each spec is a name, an LLM-facing description, a JSON Schema for its arguments,
and an async handler that runs against a :class:`~archil.FileSystem` (a ``Disk``
or a ``Workspace``). The same specs back every framework adapter; the adapters
only reshape these into the object each framework expects. Handlers return plain
strings (universal across frameworks) and turn failures into readable text so
the model can recover.

Handlers run on whatever event loop the agent framework drives, while the SDK's
httpx clients live on synchronicity's background loop. To bridge the two safely
the bound filesystem is the *public* (wrapped) ``Disk`` / ``Workspace`` and the
handlers call its ``.aio`` variants — never impl coroutines, which would attach
the clients to the wrong loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from .._paths import to_segments
from ..errors import ArchilError, ArchilS3Error

Handler = Callable[["ToolContext", dict], Awaitable[str]]


class ToolError(Exception):
    """A user-readable failure raised inside a tool handler. ``invoke`` catches
    it and hands the message back to the model as the tool result, so the agent
    reads the error and recovers rather than the whole run crashing."""


@dataclass(frozen=True)
class ToolContext:
    """What the bound tools operate on: a filesystem (public ``Disk`` /
    ``Workspace``) plus the presentation bits the agent layer adds — a layout
    hint appended to each description, and the container path the disks mount at
    (so ``run_bash``'s working directory lines up with the file tools' paths)."""

    fs: object  # public Disk or Workspace wrapper (call methods via .aio)
    layout_hint: str
    exec_root: str


def build_context(fs: object) -> ToolContext:
    """Build a :class:`ToolContext` from any filesystem. A workspace is detected
    by its ``disk_names()`` method (duck-typed so this layer needn't import the
    class); its disks are top-level directories, a single disk is rooted at ``/``."""
    disk_names = getattr(fs, "disk_names", None)
    if callable(disk_names):
        names = list(disk_names())
        disks = ", ".join(f"/{n}" for n in names)
        return ToolContext(
            fs=fs,
            layout_hint=(
                f"Each disk is a top-level directory: {disks}. Address files by full "
                "path, e.g. '/data/reports/q1.csv'; list_files('/') lists the disks. "
                "run_bash starts at the common root, so 'data/reports/q1.csv' works there too."
            ),
            exec_root="/mnt/archil",
        )
    return ToolContext(
        fs=fs,
        layout_hint=(
            "The disk is the filesystem root: address files by path from '/', "
            "e.g. '/reports/q1.csv' (a leading slash is optional). run_bash "
            "starts in this root, so the same relative paths work there."
        ),
        exec_root="/mnt",
    )


def _to_key(ctx: ToolContext, path: str) -> str:
    """Translate an agent-facing path to the key the ``FileSystem`` methods take.
    Strips the container mount root (``/mnt`` single, ``/mnt/archil`` workspace)
    so a path copied from a ``run_bash`` command resolves the same, drops the
    leading slash, and resolves ``.``/``..``. For a workspace the result's first
    segment is the disk name (which the workspace routes on)."""
    return "/".join(to_segments(path, ctx.exec_root))


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict
    handler: Handler


@dataclass(frozen=True)
class BoundTool:
    """A spec bound to a context. ``invoke`` is the single entry point adapters
    call; it never raises for an expected failure — it returns the message as the
    tool result so the agent reads it and keeps going."""

    name: str
    description: str
    parameters: dict
    context: ToolContext
    handler: Handler

    async def invoke(self, args: Optional[dict]) -> str:
        try:
            return await self.handler(self.context, args or {})
        except ToolError as exc:
            return f"Error: {exc}"
        except ArchilS3Error as exc:
            if exc.status == 404:
                path = (args or {}).get("path")
                return f"Error: file not found: {path}" if path else f"Error: {exc}"
            return f"Error: {exc}"
        except ArchilError as exc:
            return f"Error: {exc}"
        except Exception as exc:
            # The contract is "errors are returned, not thrown" so the agent can
            # read the message and recover — catch anything the handler raised
            # (bad arguments, unexpected failures) rather than aborting the run.
            return f"Error: {exc}"


def _require_str(args: dict, key: str, *, allow_empty: bool = False) -> str:
    value = args.get(key)
    if not isinstance(value, str) or (value == "" and not allow_empty):
        raise ToolError(f"missing required argument {key!r}")
    return value


def _as_bool(value: object, default: bool) -> bool:
    """Coerce a tool argument to bool. A model may send a JSON string rather than
    a real boolean, and ``bool("false")`` is ``True`` in Python — so parse common
    string forms explicitly instead of relying on truthiness."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _as_int(value: object, default: int) -> int:
    """Coerce a tool argument to int. Rejects bool (a bool is an int subclass, so
    ``int(True)`` is 1) and falls back to ``default`` for anything non-numeric."""
    if value is None or isinstance(value, bool):
        return default
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


# --- handlers --------------------------------------------------------------


async def _read_file(ctx: ToolContext, args: dict) -> str:
    path = _require_str(args, "path")
    data = await ctx.fs.get_object.aio(_to_key(ctx, path))
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return f"{path} is a binary file ({len(data)} bytes) and cannot be shown as text."
    return text if text else f"{path} is empty."


async def _write_file(ctx: ToolContext, args: dict) -> str:
    path = _require_str(args, "path")
    content = _require_str(args, "content", allow_empty=True)
    await ctx.fs.put_object.aio(_to_key(ctx, path), content)
    return f"Wrote {len(content.encode('utf-8'))} bytes to {path}."


async def _delete_file(ctx: ToolContext, args: dict) -> str:
    path = _require_str(args, "path")
    await ctx.fs.delete_object.aio(_to_key(ctx, path))
    return f"Deleted {path}."


async def _list_files(ctx: ToolContext, args: dict) -> str:
    path = args.get("path") or "/"
    recursive = _as_bool(args.get("recursive"), False)
    key = _to_key(ctx, path)
    result = await ctx.fs.list_objects.aio(f"{key}/" if key else None, recursive=recursive)
    lines = [f"dir   /{cp.rstrip('/')}/" for cp in result.common_prefixes]
    lines += [f"file  /{obj.key}  ({obj.size} bytes)" for obj in result.objects]
    lines.sort()
    # is_truncated here means part of the listing is missing — for a workspace, a
    # disk that failed the fan-out. Warn so the agent doesn't read it as complete.
    caveat = "… some files could not be listed; results may be incomplete." if result.is_truncated else ""
    if not lines:
        return f"{path}: {caveat}" if caveat else f"{path} is empty or does not exist."
    body = "\n".join(lines)
    return f"Contents of {path}:\n{body}" + (f"\n{caveat}" if caveat else "")


def _grep_caveat(result) -> str:
    """A note warning the model when grep results may be partial — distinguishing
    a truncated result (more matches exist) from a search that couldn't complete
    (deadline, scan error, or a failed directory listing)."""
    reason = result.stopped_reason
    if reason == "max_results":
        return f"… more matches exist; showing the first {len(result.matches)}."
    if reason == "deadline":
        return "… search hit the time limit; results may be incomplete."
    if reason == "incomplete":
        return "… some files could not be searched; results may be incomplete."
    if reason == "list_failed":
        return "… listing failed for part of the tree; results may be partial."
    return ""


def _root_match_path(file: str) -> str:
    """Root a grep match path with a leading slash. A workspace already roots
    paths by disk (``/data/...``); a single disk reports disk-relative keys, so
    prefix ``/`` to present both consistently."""
    return file if file.startswith("/") else f"/{file}"


async def _grep(ctx: ToolContext, args: dict) -> str:
    pattern = _require_str(args, "pattern")
    path = args.get("path") or "/"
    recursive = _as_bool(args.get("recursive"), True)
    max_results = _as_int(args.get("max_results"), 200)
    result = await ctx.fs.grep.aio(
        directory=_to_key(ctx, path),
        pattern=pattern,
        recursive=recursive,
        max_results=max_results,
        max_duration_seconds=30,
    )
    caveat = _grep_caveat(result)
    if not result.matches:
        msg = f"No matches for /{pattern}/ under {path} ({result.files_scanned} files scanned)."
        return f"{msg} {caveat}" if caveat else msg
    lines = [f"{_root_match_path(m.file)}:{m.line}: {m.text}" for m in result.matches]
    if caveat:
        lines.append(caveat)
    return "\n".join(lines)


async def _run_bash(ctx: ToolContext, args: dict) -> str:
    command = _require_str(args, "command")
    # Start in the mount root so a shell-relative path matches what the file
    # tools see (the disks live under exec_root in the exec container).
    result = await ctx.fs.exec.aio(f"cd {ctx.exec_root} && {command}")
    parts = [f"exit code: {result.exit_code}"]
    if result.stdout:
        parts.append(f"stdout:\n{result.stdout}")
    if result.stderr:
        parts.append(f"stderr:\n{result.stderr}")
    return "\n".join(parts)


# --- specs -----------------------------------------------------------------


def _obj(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


_PATH = {"type": "string", "description": "Path to the file from the filesystem root, e.g. /reports/q1.csv."}
# `recursive`/`max_results` also accept the JSON string forms a model often sends
# ("false", "50"); the handlers coerce via _as_bool/_as_int. The schema must allow
# strings too, or a schema-validating adapter (e.g. LangChain's StructuredTool)
# would reject them before the handler runs.
_RECURSIVE = {"type": ["boolean", "string"], "description": "List/search the full subtree."}
_MAX_RESULTS = {"type": ["integer", "string"], "description": "Cap on matches (default 200)."}

SPECS: list[ToolSpec] = [
    ToolSpec(
        name="read_file",
        description="Read the contents of a text file and return them.",
        parameters=_obj({"path": _PATH}, ["path"]),
        handler=_read_file,
    ),
    ToolSpec(
        name="write_file",
        description="Create or overwrite a file with the given text content.",
        parameters=_obj(
            {
                "path": _PATH,
                "content": {"type": "string", "description": "Full contents to write."},
            },
            ["path", "content"],
        ),
        handler=_write_file,
    ),
    ToolSpec(
        name="delete_file",
        description="Delete a file. Succeeds even if the file does not exist.",
        parameters=_obj({"path": _PATH}, ["path"]),
        handler=_delete_file,
    ),
    ToolSpec(
        name="list_files",
        description=(
            "List files and subdirectories. Omit 'path' to list from the root. "
            "Set 'recursive' to list the whole subtree."
        ),
        parameters=_obj(
            {
                "path": {"type": "string", "description": "Directory to list (optional)."},
                "recursive": _RECURSIVE,
            },
            [],
        ),
        handler=_list_files,
    ),
    ToolSpec(
        name="grep",
        description=(
            "Search file contents for an extended regular expression and return "
            "matching lines as path:line: text. Searches recursively by default."
        ),
        parameters=_obj(
            {
                "pattern": {"type": "string", "description": "Extended regex (grep -E)."},
                "path": {"type": "string", "description": "Directory to search (optional)."},
                "recursive": _RECURSIVE,
                "max_results": _MAX_RESULTS,
            },
            ["pattern"],
        ),
        handler=_grep,
    ),
    ToolSpec(
        name="run_bash",
        description=(
            "Run a bash command in an ephemeral sandbox with the filesystem "
            "mounted. The working directory is the filesystem root, so paths "
            "match the other tools. Returns the exit code, stdout, and stderr."
        ),
        parameters=_obj(
            {"command": {"type": "string", "description": "The bash command to run."}},
            ["command"],
        ),
        handler=_run_bash,
    ),
]

_SPEC_NAMES = [s.name for s in SPECS]


def bind_tools(fs: object, names: Optional[list[str]] = None) -> list[BoundTool]:
    """Bind the specs (optionally a subset, by name) to a filesystem. The layout
    hint is appended to each description so the model knows where files live and
    which paths to pass."""
    if names is not None:
        unknown = [n for n in names if n not in _SPEC_NAMES]
        if unknown:
            raise ValueError(f"unknown tool(s) {unknown}; available: {_SPEC_NAMES}")
        chosen = [s for s in SPECS if s.name in set(names)]
    else:
        chosen = list(SPECS)
    ctx = build_context(fs)
    return [
        BoundTool(
            name=s.name,
            description=f"{s.description} {ctx.layout_hint}",
            parameters=s.parameters,
            context=ctx,
            handler=s.handler,
        )
        for s in chosen
    ]
