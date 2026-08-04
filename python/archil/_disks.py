from __future__ import annotations

from typing import AsyncIterator, Optional, Sequence

from archil_openapi.api.disks import create_disk, get_disk, list_disks
from archil_openapi.models.create_disk_request import CreateDiskRequest
from archil_openapi.types import UNSET, Unset

from ._disk import _Disk
from ._http import _Transport
from ._models import CreateDiskResult, DiskPage, MountConfig
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
        response = self._transport.unwrap(
            await list_disks.asyncio_detailed(
                client=self._transport.openapi,
                limit=UNSET if limit is None else limit,
                cursor=UNSET if cursor is None else cursor,
                name=UNSET if name is None else name,
            )
        )
        disks = [_Disk(self._transport, self._region, disk) for disk in response.data]
        next_cursor = None if isinstance(response.next_cursor, Unset) else response.next_cursor
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
        response = self._transport.unwrap(
            await get_disk.asyncio_detailed(id, client=self._transport.openapi)
        )
        return _Disk(self._transport, self._region, response.data)

    async def create(
        self,
        *,
        name: str,
        mounts: Optional[Sequence[MountConfig]] = None,
        allowed_ips: Optional[list[str]] = None,
    ) -> CreateDiskResult:
        """Create a new disk with an auto-generated mount token.

        Returns the Disk, the one-time token (save it — it cannot be retrieved
        again), and the token identifier for later management."""
        response = self._transport.unwrap(
            await create_disk.asyncio_detailed(
                client=self._transport.openapi,
                body=CreateDiskRequest(
                    name=name,
                    mounts=UNSET if mounts is None else list(mounts),
                    allowed_ips=UNSET if allowed_ips is None else allowed_ips,
                ),
            )
        )
        created = response.data
        if isinstance(created.disk_id, Unset):
            raise RuntimeError("API returned success but no diskId")
        disk_id = created.disk_id

        authorized_users = (
            [] if isinstance(created.authorized_users, Unset) else created.authorized_users
        )
        token_user = next(
            (u for u in authorized_users if not isinstance(u.token, Unset)), None
        )

        disk = await self.get(disk_id)
        return CreateDiskResult(
            disk=translate_out(disk),
            token=None if token_user is None else token_user.token,
            token_identifier=(
                None
                if token_user is None or isinstance(token_user.identifier, Unset)
                else token_user.identifier
            ),
            authorized_users=authorized_users,
        )
