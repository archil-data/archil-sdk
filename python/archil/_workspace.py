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
from dataclasses import dataclass, replace
from typing import List, Optional

from ._http import BodyType
from ._models import (
    ExecResult,
    GrepGroup,
    GrepMatch,
    GrepResult,
    ListObjectsResult,
    PutObjectResult,
    S3Object,
)
from ._paths import to_segments
from ._synchronizer import translate_in, translate_out
from .errors import ArchilApiError

# Imported at runtime (not under TYPE_CHECKING) so the synchronicity stub
# generator can resolve agent_tools()'s return type. agent_tools does not import
# _workspace, so this does not create an import cycle.
from .agent_tools import AgentToolset


def _truncate_groups(
    groups: List[GrepGroup], max_results: int, after: int, multiline: bool
) -> List[GrepGroup]:
    """Keep groups up to the one holding the ``max_results``-th match, and end
    that group after up to ``after`` more lines, which become context so the
    groups hold exactly the kept matches. With multiline, a run of matching
    lines is one match. Mirrors the controlplane's truncation of a single
    disk's groups."""
    seen = 0
    for i, g in enumerate(groups):
        lines = g.lines
        for j, line in enumerate(lines):
            if line.match and not (multiline and j > 0 and lines[j - 1].match):
                seen += 1
            if seen == max_results and not (multiline and j + 1 < len(lines) and lines[j + 1].match):
                kept = [
                    replace(ln, match=False) if k > j else ln
                    for k, ln in enumerate(lines[: j + 1 + after])
                ]
                return [*groups[:i], replace(g, lines=kept)]
    return groups


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

    def _root_globs(self, globs: List[str]) -> dict[str, List[str]]:
        """Route grep globs written against the workspace root to the mounts they
        can match. A glob that starts with a mount's name goes to that mount
        without the name. One with no ``/``, or that starts with ``**/`` with or
        without a leading ``/``, goes to every mount as written, and also applies
        to a mount it names exactly, like ``!cache`` or ``**/logs/**``. Mount
        names are matched literally, so ``!l*`` doesn't skip a ``logs`` mount.
        Leaves out a mount whose directory an exclude names, or that no include
        reaches, and raises for any other glob with a ``/``."""
        routed: dict[str, List[str]] = {name: [] for name in self._mounts}
        excluded: set[str] = set()
        for glob in globs:
            exclude = glob.startswith("!")
            body = glob[1:] if exclude else glob
            dir_only = body.endswith("/")
            if dir_only:
                body = body[:-1]
            anchored = body.startswith("/")
            if anchored:
                body = body[1:]
            # A glob with no `/` or that starts with `**/` matches inside every
            # mount, and a leading `/` doesn't narrow a leading `**`. At the root
            # it also matches a mount it names exactly: the mount's directory, or
            # after a leading `**/`, paths under it.
            everywhere = (not anchored and "/" not in body) or body == "**" or body.startswith("**/")
            if everywhere:
                for mount_globs in routed.values():
                    mount_globs.append(glob)
            path = body[3:] if everywhere and body.startswith("**/") else body
            name, _, rest = path.partition("/")
            if name not in routed:
                if everywhere:
                    continue
                raise ValueError(
                    "At the workspace root, a glob with a '/' must start with a mount name ("
                    + ", ".join(f"{n}/" for n in self._mounts)
                    + f") or '**/'; got {glob!r}. To search below one mount, set directory to it."
                )
            if not rest:
                # The glob names the mount's own directory, so the last one
                # decides whether the mount is searched at all.
                if exclude:
                    excluded.add(name)
                else:
                    excluded.discard(name)
                continue
            # The control plane reads a glob without a `/` as a name at any depth.
            rest = rest if "/" in rest else f"/{rest}"
            routed[name].append(f"{'!' if exclude else ''}{rest}{'/' if dir_only else ''}")
        has_include = any(not glob.startswith("!") for glob in globs)
        return {
            name: mount_globs
            for name, mount_globs in routed.items()
            if name not in excluded and not (has_include and all(g.startswith("!") for g in mount_globs))
        }

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
        ignore_case: bool = False,
        multiline: bool = False,
        globs: Optional[List[str]] = None,
        types: Optional[List[str]] = None,
        types_not: Optional[List[str]] = None,
        context_before: int = 0,
        context_after: int = 0,
    ) -> GrepResult:
        """Grep the disks ``directory`` covers in parallel and merge their
        results. At the workspace root, a glob with a ``/`` must start with a
        mount name, like ``data/src/**``, which applies to that mount only, or
        with ``**/``. A glob with no ``/``, like ``*.ts``, or one starting with
        ``**/`` with or without a leading ``/``, applies inside every mount, and
        also to a mount it names exactly, so ``!cache`` skips the cache mount.
        Mount names are matched literally, not as patterns: ``!l*`` applies
        inside every mount, but doesn't skip a mount named ``logs``."""
        # At the root, glob paths start with a mount's name, which its disk's
        # paths lack, so route each glob to the mounts it can match.
        root_globs = self._root_globs(globs) if globs and not to_segments(directory) else None
        covered = []
        for name, entry, rel in self._covered(directory):
            mount_globs = globs if root_globs is None else root_globs.get(name)
            if root_globs is not None and mount_globs is None:
                continue
            covered.append((name, entry, rel, mount_globs))
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
                    ignore_case=ignore_case,
                    multiline=multiline,
                    globs=mount_globs,
                    types=types,
                    types_not=types_not,
                    context_before=context_before,
                    context_after=context_after,
                )
                for _, entry, rel, mount_globs in covered
            ),
            return_exceptions=True,
        )
        # Except a 400: the control plane rejects a bad request before it looks
        # at the disk, so every disk fails alike and the error belongs to the caller.
        for r in results:
            if isinstance(r, ArchilApiError) and r.status == 400:
                raise r
        matches: List[GrepMatch] = []
        groups: List[GrepGroup] = []
        files_scanned = containers_dispatched = duration_ms = listing_ms = grep_ms = 0
        compute_seconds_used = 0.0
        reasons: set[str] = set()
        for (name, entry, _, _), r in zip(covered, results):
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
                matches.append(replace(m, file=self._abs(name, entry, m.file)))
            for g in r.groups or []:
                groups.append(replace(g, file=self._abs(name, entry, g.file)))
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
        if len(matches) > max_results:
            groups = _truncate_groups(groups, max_results, context_after, multiline)
        return GrepResult(
            matches=matches[:max_results],
            stopped_reason=stopped_reason,
            files_scanned=files_scanned,
            containers_dispatched=containers_dispatched,
            compute_seconds_used=compute_seconds_used,
            duration_ms=duration_ms,
            listing_ms=listing_ms,
            grep_ms=grep_ms,
            groups=groups if context_before > 0 or context_after > 0 else None,
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
