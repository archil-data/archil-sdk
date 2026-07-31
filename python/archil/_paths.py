"""Path normalization shared by :class:`Disk` and :class:`Workspace`.

Turns an agent/user path into root-relative segments, resolving "." and ".."
(so a path means the same as in a shell and ".." can't escape above the root)
and optionally stripping a shell-style container-mount prefix (e.g. "/mnt" or
"/mnt/archil") so a path copied from a ``run_bash`` command resolves the same.

    to_segments("/a/b/../c")            -> ["a", "c"]
    to_segments("/mnt/x", "/mnt")        -> ["x"]
    to_segments("/../../etc/x")          -> ["etc", "x"]
"""

from __future__ import annotations

from typing import Optional


def to_segments(path: str, container_root: Optional[str] = None) -> list[str]:
    p = (path or "").strip()
    if container_root:
        root = container_root.rstrip("/")
        if p == root:
            p = "/"
        elif p.startswith(root + "/"):
            p = p[len(root):]
    resolved: list[str] = []
    for seg in p.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if resolved:
                resolved.pop()
        else:
            resolved.append(seg)
    return resolved
