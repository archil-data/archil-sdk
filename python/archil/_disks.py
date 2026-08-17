from __future__ import annotations

from typing import AsyncIterator, Optional, Sequence

from ._disk import _Disk
from ._http import _Transport
from ._models import (
    AuthorizedUser,
    CreateDiskResult,
    DiskData,
    DiskPage,
    MountConfig,
    RootAttrs,
)
from ._synchronizer import translate_out

# Server-side maximum page size for GET /api/disks (requests above it are clamped).
_DISK_PAGE_LIMIT = 100


class _Disks:
    """Account-level disk collection: list, look up, and create disks.

    Every method is available both synchronously and asynchronously — call it
    directly to block, or use ``.aio`` for a coroutine
    (e.g. ``await archil.disks.get.aio(disk_id)``)."""

    def __init__(self, transport: _Transport, region: str) -> None:
        self._transport = transport
        self._region = region

    async def _page(
        self, *, limit: Optional[int], cursor: Optional[str], name: Optional[str] = None
    ) -> tuple[list["_Disk"], Optional[str]]:
        data, next_cursor = await self._transport.request_json_page(
            "GET", "/api/disks", params={"limit": limit, "cursor": cursor, "name": name}
        )
        # `data or []`: the list endpoint can come back as JSON `null` (Go nil
        # slice) for an empty account, which would otherwise raise TypeError.
        disks = [_Disk(self._transport, self._region, DiskData.from_json(d)) for d in (data or [])]
        return disks, next_cursor

    async def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        name: Optional[str] = None,
    ) -> list["_Disk"]:
        """List the account's disks. Fetches in cursor-driven pages (bounded
        server work per request) and follows ``nextCursor`` until exhausted, so
        the returned list is complete even for very large accounts. Use ``limit``
        to cap the total, or ``list_pages`` to walk pages yourself.

        Async: ``await archil.disks.list.aio()``."""
        if name is not None:
            disks, _ = await self._page(limit=limit, cursor=cursor, name=name)
            return disks

        disks: list[_Disk] = []
        while True:
            remaining = None if limit is None else limit - len(disks)
            if remaining is not None and remaining <= 0:
                return disks
            page_limit = _DISK_PAGE_LIMIT if remaining is None else min(remaining, _DISK_PAGE_LIMIT)
            page, next_cursor = await self._page(limit=page_limit, cursor=cursor)
            # A server that predates pagination ignores `limit` and returns the
            # full list; slice so the cap still holds.
            disks.extend(page[:remaining] if remaining is not None else page)
            # A repeated cursor means no forward progress — never loop forever.
            if not next_cursor or next_cursor == cursor:
                return disks
            cursor = next_cursor

    async def list_pages(
        self,
        *,
        cursor: Optional[str] = None,
        page_size: Optional[int] = None,
    ) -> AsyncIterator[DiskPage]:
        """Yield pages of disks lazily, following ``nextCursor`` — each page's
        ``next_cursor`` can also be persisted to resume listing later.

        Sync iteration: ``for page in archil.disks.list_pages(): ...``.
        Async iteration: ``async for page in archil.disks.list_pages.aio(): ...``."""
        limit = min(page_size or _DISK_PAGE_LIMIT, _DISK_PAGE_LIMIT)
        while True:
            disks, next_cursor = await self._page(limit=limit, cursor=cursor)
            yield DiskPage(disks=[translate_out(d) for d in disks], next_cursor=next_cursor)
            if not next_cursor or next_cursor == cursor:
                return
            cursor = next_cursor

    async def get(self, id: str) -> "_Disk":
        data = await self._transport.request_json("GET", f"/api/disks/{id}")
        return _Disk(self._transport, self._region, DiskData.from_json(data))

    async def create(
        self,
        *,
        name: str,
        mounts: Optional[Sequence[MountConfig]] = None,
        allowed_ips: Optional[list[str]] = None,
        root_attrs: Optional[RootAttrs] = None,
    ) -> CreateDiskResult:
        """Create a new disk with an auto-generated mount token.

        Returns the Disk, the one-time token (save it — it cannot be retrieved
        again), and the token identifier for later management.

        ``root_attrs`` sets the POSIX owner and mode of the disk's root
        directory (e.g. ``RootAttrs(uid=1000, gid=1000, mode=0o755)`` so an
        unprivileged process can create entries under the mount root without
        a post-mount ``chown``). Creation-time only."""
        body: dict = {"name": name}
        if mounts is not None:
            body["mounts"] = [m.to_json() for m in mounts]
        if allowed_ips is not None:
            body["allowedIps"] = allowed_ips
        if root_attrs is not None:
            body["rootAttrs"] = root_attrs.to_json()

        created = await self._transport.request_json("POST", "/api/disks", json=body)
        disk_id = created.get("diskId")
        if not disk_id:
            raise RuntimeError("API returned success but no diskId")

        authorized_users = [
            AuthorizedUser.from_json(u) for u in (created.get("authorizedUsers") or [])
        ]
        token_user = next((u for u in authorized_users if u.token), None)

        disk = await self.get(disk_id)
        return CreateDiskResult(
            disk=translate_out(disk),
            token=token_user.token if token_user else None,
            token_identifier=token_user.identifier if token_user else None,
            authorized_users=authorized_users,
        )
