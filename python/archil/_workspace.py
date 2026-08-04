"""A key-routed filesystem spanning several Archil disks.

Each disk is mounted under a name and addressed as the first segment of a key
(``<name>/...``); ``get_object``, ``put_object``, ``delete_object``,
``list_objects``, and ``grep`` route to the right disk by that segment (and
``list_objects`` / ``grep`` fan out across all of them when the key/prefix
doesn't name one). Implements the same :class:`FileSystem` surface as a single
:class:`Disk` — using the very same method names — so it works anywhere a disk
does, not just with the agent tools. Mounts can be changed at runtime with
:meth:`add_disk` / :meth:`remove_disk`.

Like the rest of the SDK this is a synchronicity-wrapped impl: it holds the
*impl* disks and client (normalized via ``translate_in``) so its async methods
await them directly on the shared loop.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import List, Optional

from archil_openapi.models.exec_disk_result import ExecDiskResult as ExecResult
from archil_openapi.models.grep_disk_result import GrepDiskResult as GrepResult
from archil_openapi.models.grep_match import GrepMatch
from archil_openapi.models.grep_stopped_reason import GrepStoppedReason

from ._http import BodyType
from ._models import ListObjectsResult, PutObjectResult, S3Object
from ._paths import to_segments
from ._synchronizer import translate_in, translate_out

# Imported at runtime (not under TYPE_CHECKING) so the synchronicity stub
# generator can resolve agent_tools()'s return type. agent_tools does not import
# _workspace, so this does not create an import cycle.
from .agent_tools import AgentToolset


@dataclass
class _Mount:
    disk: object  # impl _Disk
    read_only: bool = False
    subdirectory: Optional[str] = None
    conditional: bool = False


class _Workspace:
    """Use ``archil.workspace({...})`` to build one."""

    def __init__(self, client: object, mounts: dict) -> None:
        self._client = client  # impl _Archil
        self._mounts: dict[str, _Mount] = {}
        for name, value in mounts.items():
            self.add_disk(name, value)
        if not self._mounts:
            raise ValueError("workspace() needs at least one disk")

    # --- mount management --------------------------------------------------

    def add_disk(self, name: str, disk: object) -> "_Workspace":
        """Mount (or replace) a disk at ``name``; its objects are addressed as
        ``<name>/...``. Accepts a ``Disk`` or an ``ExecMountSpec`` (read-only /
        subdirectory / conditional); a bare disk-id string is rejected — fetch
        the disk first."""
        from ._archil import ExecMountSpec

        rel = name.strip("/")
        if not rel:
            raise ValueError("workspace mount name must be non-empty")
        # Routing is by the first key segment, so a mount name can't contain "/".
        if "/" in rel:
            raise ValueError(f"workspace mount name {name!r} must not contain '/'")
        # "." and ".." are path navigation to the router, not addressable labels.
        if rel in (".", ".."):
            raise ValueError(
                f"workspace mount name {name!r} is reserved ('.' and '..' are path navigation, not disk names)"
            )
        if isinstance(disk, ExecMountSpec):
            d, read_only, subdirectory, conditional = (
                disk.disk, disk.read_only, disk.subdirectory, disk.conditional
            )
        else:
            d, read_only, subdirectory, conditional = disk, False, None, False
        if isinstance(d, str):
            raise ValueError(
                "workspace needs Disk objects, not disk-id strings; "
                "fetch the disk with archil.get_disk(id) first"
            )
        self._mounts[rel] = _Mount(
            disk=translate_in(d), read_only=read_only, subdirectory=subdirectory, conditional=conditional
        )
        return self

    def remove_disk(self, name: str) -> bool:
        """Unmount the disk at ``name``. Returns whether a disk was removed.
        Refuses to remove the last disk — a workspace must always have at least
        one (the same invariant the constructor enforces), else fan-out/exec
        would have nothing to route to."""
        rel = name.strip("/")
        if rel in self._mounts and len(self._mounts) == 1:
            raise ValueError(
                "cannot remove the last disk from a workspace; a workspace must keep at least one"
            )
        return self._mounts.pop(rel, None) is not None

    def disk_names(self) -> List[str]:
        """The names of the currently-mounted disks."""
        return list(self._mounts)

    # --- routing -----------------------------------------------------------

    def _unknown_disk(self, name: str) -> ValueError:
        return ValueError(
            f"No disk named {name!r}. Address objects by disk: "
            + ", ".join(f"{n}/…" for n in self._mounts)
        )

    def _route(self, key: str) -> tuple[_Mount, str]:
        segs = to_segments(key)
        if not segs:
            raise ValueError("that key is the workspace root, not an object; name a disk, e.g. data/file.txt")
        entry = self._mounts.get(segs[0])
        if entry is None:
            raise self._unknown_disk(segs[0])
        return entry, self._disk_key(entry, "/".join(segs[1:]))

    def _covered(self, prefix: str) -> list[tuple[str, _Mount, str]]:
        """Mounts touched by a key prefix; an empty prefix fans out to all of them."""
        segs = to_segments(prefix)
        if not segs:
            return [(name, entry, self._disk_key(entry, "")) for name, entry in self._mounts.items()]
        entry = self._mounts.get(segs[0])
        if entry is None:
            raise self._unknown_disk(segs[0])
        return [(segs[0], entry, self._disk_key(entry, "/".join(segs[1:])))]

    def _disk_key(self, entry: _Mount, rel: str) -> str:
        rel = rel.lstrip("/")
        sub = (entry.subdirectory or "").strip("/")
        if not sub:
            return rel
        return f"{sub}/{rel}" if rel else sub

    def _abs(self, name: str, entry: _Mount, disk_key: str) -> str:
        sub = (entry.subdirectory or "").strip("/")
        rel = disk_key
        if sub and disk_key.startswith(sub + "/"):
            rel = disk_key[len(sub) + 1:]
        elif sub and disk_key == sub:
            rel = ""
        rel = rel.strip("/")
        return f"{name}/{rel}" if rel else name

    # --- FileSystem --------------------------------------------------------

    async def get_object(self, key: str) -> bytes:
        entry, disk_key = self._route(key)
        return await entry.disk.get_object(disk_key)

    async def put_object(
        self,
        key: str,
        body: BodyType,
        content_type: Optional[str] = None,
        *,
        mode: Optional[int] = None,
        uid: Optional[int] = None,
        gid: Optional[int] = None,
    ) -> PutObjectResult:
        entry, disk_key = self._route(key)
        if entry.read_only:
            raise ValueError(f"{key} is on a read-only disk and cannot be written.")
        return await entry.disk.put_object(
            disk_key, body, content_type, mode=mode, uid=uid, gid=gid
        )

    async def delete_object(self, key: str) -> None:
        entry, disk_key = self._route(key)
        if entry.read_only:
            raise ValueError(f"{key} is on a read-only disk and cannot be deleted.")
        await entry.disk.delete_object(disk_key)

    async def list_objects(self, prefix: Optional[str] = None, *, recursive: bool = False) -> ListObjectsResult:
        # At the workspace root, the disks themselves are the top-level directories.
        # A non-recursive listing returns just those (like a delimited S3 listing),
        # rather than fanning out into each disk's contents — that only happens when
        # recursive is set or a prefix names a disk.
        if not to_segments(prefix or "") and not recursive:
            return ListObjectsResult(
                objects=[],
                common_prefixes=sorted(f"{n}/" for n in self._mounts),
                is_truncated=False,
                key_count=0,
                prefix=prefix,
            )
        covered = self._covered(prefix or "")
        # Fan out resiliently: a disk that errors shouldn't sink the whole listing
        # — skip it and flag the result incomplete (is_truncated) rather than raise.
        listings = await asyncio.gather(
            *(self._list_one(entry, rel, recursive) for _, entry, rel in covered),
            return_exceptions=True,
        )
        objects: List[S3Object] = []
        common_prefixes: List[str] = []
        is_truncated = False
        key_count = 0
        for (name, entry, _), listing in zip(covered, listings):
            if isinstance(listing, BaseException):
                is_truncated = True  # a disk failed → the merged listing may be incomplete
                continue
            for cp in listing.common_prefixes:
                common_prefixes.append(f"{self._abs(name, entry, cp.rstrip('/'))}/")
            for obj in listing.objects:
                objects.append(
                    S3Object(
                        key=self._abs(name, entry, obj.key),
                        size=obj.size,
                        etag=obj.etag,
                        last_modified=obj.last_modified,
                    )
                )
            is_truncated = is_truncated or listing.is_truncated
            key_count += listing.key_count
        objects.sort(key=lambda o: o.key)
        common_prefixes.sort()
        return ListObjectsResult(
            objects=objects,
            common_prefixes=common_prefixes,
            is_truncated=is_truncated,
            key_count=key_count,
            prefix=prefix,
        )

    async def _list_one(self, entry: _Mount, rel: str, recursive: bool):
        disk_prefix = f"{rel}/" if rel and not rel.endswith("/") else (rel or None)
        return await entry.disk.list_objects(disk_prefix, recursive=recursive)

    async def grep(
        self,
        *,
        directory: str,
        pattern: str,
        recursive: bool = False,
        max_duration_seconds: int = 30,
        concurrency: int = 50,
        max_results: int = 1000,
    ) -> GrepResult:
        covered = self._covered(directory)
        # Fan out resiliently: a disk that errors contributes a "list_failed"
        # reason (surfaced as a partial-results caveat) instead of failing the grep.
        results = await asyncio.gather(
            *(
                entry.disk.grep(
                    directory=rel,
                    pattern=pattern,
                    recursive=recursive,
                    max_duration_seconds=max_duration_seconds,
                    concurrency=concurrency,
                    max_results=max_results,
                )
                for _, entry, rel in covered
            ),
            return_exceptions=True,
        )
        matches: List[GrepMatch] = []
        files_scanned = containers_dispatched = duration_ms = listing_ms = grep_ms = 0
        compute_seconds_used = 0.0
        reasons: set[str] = set()
        for (name, entry, _), r in zip(covered, results):
            if isinstance(r, BaseException):
                reasons.add("list_failed")
                continue
            files_scanned += r.files_scanned
            containers_dispatched += r.containers_dispatched
            compute_seconds_used += r.compute_seconds_used
            duration_ms = max(duration_ms, r.duration_ms)
            listing_ms = max(listing_ms, r.listing_ms)
            grep_ms = max(grep_ms, r.grep_ms)
            reasons.add(r.stopped_reason)
            for m in r.matches:
                matches.append(GrepMatch(self._abs(name, entry, m.file), m.line, m.text))
        # Merging across disks can exceed the cap even when every disk completed,
        # so flag the truncation ourselves before slicing — otherwise the extra
        # matches are dropped with no signal.
        if len(matches) > max_results:
            reasons.add("max_results")
        # Report the most serious reason so a listing/scan failure on one disk
        # isn't masked by a truncation reason on another.
        priority = ("list_failed", "incomplete", "deadline", "max_results")
        stopped_reason = (
            "completed" if reasons <= {"completed"}
            else next((r for r in priority if r in reasons), "completed")
        )
        return GrepResult(
            matches=matches[:max_results],
            stopped_reason=GrepStoppedReason(stopped_reason),
            files_scanned=files_scanned,
            containers_dispatched=containers_dispatched,
            compute_seconds_used=compute_seconds_used,
            duration_ms=duration_ms,
            listing_ms=listing_ms,
            grep_ms=grep_ms,
        )

    async def exec(self, command: str) -> ExecResult:
        from ._archil import ExecMountSpec

        disks: dict = {}
        for name, entry in self._mounts.items():
            if entry.read_only or entry.subdirectory or entry.conditional:
                disks[name] = ExecMountSpec(
                    disk=entry.disk,
                    subdirectory=entry.subdirectory,
                    read_only=entry.read_only,
                    conditional=entry.conditional,
                )
            else:
                disks[name] = entry.disk
        return await self._client.exec(disks=disks, command=command)

    # --- agent tools -------------------------------------------------------

    def agent_tools(self, *, tools: Optional[List[str]] = None) -> "AgentToolset":
        """Build a filesystem toolset for this workspace that drops into popular
        agent frameworks, exactly like :meth:`Disk.agent_tools` — but operations
        route to the right disk by key and ``grep`` / ``list_objects`` fan out
        across all of them.

            agent = Agent(tools=workspace.agent_tools().for_openai_agents())
        """
        from .agent_tools._toolset import AgentToolset

        return AgentToolset(translate_out(self), tools)
