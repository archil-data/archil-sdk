from __future__ import annotations

import asyncio
import gzip
import hashlib
import io
import os
import re
import stat
import tarfile
from dataclasses import dataclass
from typing import TYPE_CHECKING, Union

from .errors import ArchilError

if TYPE_CHECKING:
    from ._http import _Transport

MAX_CONTEXT_BYTES = 512 << 20
_REGEX_SPECIALS = set(".+()|{}$")


@dataclass(frozen=True)
class _Pattern:
    regex: re.Pattern[str]
    exception: bool


def _compile(pattern: str) -> re.Pattern[str]:
    # Docker's .dockerignore syntax (moby/patternmatcher): `*` and `?` stay within
    # one path segment, `**` crosses any number of them, `\` escapes the next character.
    out = "^"
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "*" and pattern[i + 1 : i + 2] == "*":
            i += 2
            if pattern[i : i + 1] == "/":
                i += 1
            out += ".*" if i == len(pattern) else "(.*/)?"
            continue
        if ch == "*":
            out += "[^/]*"
        elif ch == "?":
            out += "[^/]"
        elif ch == "\\" and i + 1 < len(pattern):
            i += 1
            out += re.escape(pattern[i])
        elif ch in _REGEX_SPECIALS:
            out += "\\" + ch
        else:
            out += ch
        i += 1
    return re.compile(out + "$")


def _read_dockerignore(directory: str) -> list[_Pattern]:
    try:
        with open(os.path.join(directory, ".dockerignore"), encoding="utf-8") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return []
    patterns = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        exception = line.startswith("!")
        if exception:
            line = line[1:].strip()
        line = os.path.normpath(line).replace(os.sep, "/").lstrip("/")
        if line and line != ".":
            patterns.append(_Pattern(_compile(line), exception))
    return patterns


def _excluded(path: str, patterns: list[_Pattern]) -> bool:
    """Whether the last pattern matching ``path`` or one of its parents excludes it."""
    parents = path.split("/")
    excluded = False
    for pattern in patterns:
        if any(pattern.regex.match("/".join(parents[: n + 1])) for n in range(len(parents))):
            excluded = not pattern.exception
    return excluded


def pack_context(directory: Union[str, os.PathLike[str]]) -> tuple[bytes, str]:
    """Pack ``directory`` into a gzip-compressed tar and return it with its hex
    SHA-256. Paths that ``.dockerignore`` excludes are left out, entries are
    sorted, and owners and modification times are zeroed, so the same files
    always produce the same archive and hash."""
    root = os.fspath(directory)
    if not os.path.isdir(root):
        raise ValueError(f"Build context {root!r} is not a directory")
    patterns = _read_dockerignore(root)
    can_reinclude = any(p.exception for p in patterns)
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:

            def add(relative: str) -> None:
                full = os.path.join(root, relative)
                info = tar.gettarinfo(full, arcname=relative)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                if info.isfile():
                    with open(full, "rb") as f:
                        tar.addfile(info, f)
                elif info.isdir() or info.issym():
                    tar.addfile(info)
                if buffer.tell() > MAX_CONTEXT_BYTES:
                    raise ValueError(f"Build context {root!r} is over {MAX_CONTEXT_BYTES >> 20} MiB compressed")

            def walk(relative: str) -> None:
                with os.scandir(os.path.join(root, relative)) as entries:
                    names = sorted(entry.name for entry in entries)
                for name in names:
                    child = f"{relative}/{name}" if relative else name
                    excluded = _excluded(child, patterns)
                    mode = os.lstat(os.path.join(root, child)).st_mode
                    if stat.S_ISDIR(mode):
                        if not excluded:
                            add(child)
                        if not excluded or can_reinclude:
                            walk(child)
                    elif not excluded and (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
                        add(child)

            walk("")
    data = buffer.getvalue()
    if len(data) > MAX_CONTEXT_BYTES:
        raise ValueError(f"Build context {root!r} is over {MAX_CONTEXT_BYTES >> 20} MiB compressed")
    return data, hashlib.sha256(data).hexdigest()


async def upload_context(transport: _Transport, directory: Union[str, os.PathLike[str]]) -> str:
    """Pack ``directory`` and upload it unless the control plane already holds
    the same archive; returns the ``sha256:`` digest a Dockerfile build names."""
    data, digest = await asyncio.to_thread(pack_context, directory)
    upload = await transport.request_json(
        "POST", "/api/images/contexts", json={"sha256": digest, "size_bytes": len(data)}, retry="transient"
    )
    if not upload["present"]:
        response = await transport.put_presigned(upload["upload_url"], upload.get("upload_headers") or {}, data)
        if not response.is_success:
            raise ArchilError(
                f"Build context upload failed with HTTP {response.status_code}: {response.text[:200]}",
                response.status_code,
                "CONTEXT_UPLOAD_FAILED",
            )
    return f"sha256:{digest}"
