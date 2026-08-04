from __future__ import annotations

import asyncio
import time
from email.utils import parsedate_to_datetime
from typing import AsyncIterator, List, Literal, Optional, Union
from xml.etree.ElementTree import ParseError

from ._http import BodyType, _Transport
from ._models import (
    AuthorizedUser,
    CompletedMultipartUpload,
    ConnectedClient,
    Delegation,
    DeleteObjectsError,
    DeleteObjectsResult,
    DiskData,
    DiskMetrics,
    DiskStatus,
    DiskUser,
    ExecResult,
    GrepResult,
    ListObjectsResult,
    MountResponse,
    MultipartUpload,
    MultipartUploadListing,
    MultipartUploadSummary,
    ObjectMetadata,
    PartInfo,
    PartListing,
    PutObjectResult,
    S3Object,
    ShareUrl,
    UploadPart,
)
from ._s3xml import (
    build_complete_multipart_upload,
    build_delete_request,
    parse_complete_multipart_upload,
    parse_delete_result,
    parse_initiate_multipart_upload,
    parse_list_multipart_uploads,
    parse_list_objects,
    parse_list_parts,
)
from .errors import ArchilS3Error, parse_s3_error

# Imported at runtime (not under TYPE_CHECKING) so the synchronicity stub
# generator can resolve agent_tools()'s return type. The agent_tools package
# imports _disk lazily, so this does not create an import cycle.
from .agent_tools import AgentToolset

# Headers the S3 gateway accepts to set POSIX mode/owner on newly created
# objects (see fshandler `x-archil-*` PutObject attrs).
_ARCHIL_MODE_HEADER = "x-archil-mode"
_ARCHIL_UID_HEADER = "x-archil-uid"
_ARCHIL_GID_HEADER = "x-archil-gid"


def _posix_create_headers(
    mode: Optional[int] = None,
    uid: Optional[int] = None,
    gid: Optional[int] = None,
) -> Optional[dict[str, str]]:
    headers: dict[str, str] = {}
    if mode is not None:
        headers[_ARCHIL_MODE_HEADER] = format(mode, "o")
    if uid is not None:
        headers[_ARCHIL_UID_HEADER] = str(uid)
    if gid is not None:
        headers[_ARCHIL_GID_HEADER] = str(gid)
    return headers or None


def _header_datetime(value: Optional[str]):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Optional[str], default: int = 0) -> int:
    """Parse an integer header leniently — a missing, empty, or malformed value
    degrades to ``default`` rather than raising a bare ValueError out of the SDK."""
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _user_payload(user: Union[DiskUser, dict]) -> dict:
    return user if isinstance(user, dict) else user.to_json()


# S3's per-request cap on DeleteObjects keys; larger inputs are auto-batched.
_MAX_DELETE_OBJECTS_PER_REQUEST = 1000
# S3's minimum size for every multipart part but the last (5 MiB).
_MIN_PART_SIZE = 5 * 1024 * 1024
# Default part size ``put_object`` uses on the multipart path (16 MiB).
_DEFAULT_PART_SIZE = 16 * 1024 * 1024
# Default number of parts ``put_object`` uploads in parallel.
_DEFAULT_UPLOAD_CONCURRENCY = 4
# The server's cap on parts in a single multipart upload (MAX_PARTS_PER_UPLOAD).
_MAX_PARTS_PER_UPLOAD = 10_000


def _to_bytes(body: BodyType) -> bytes:
    """Normalize an upload body to bytes so it can be sized and sliced into parts."""
    if isinstance(body, str):
        return body.encode("utf-8")
    return bytes(body)


def _effective_part_size(total_bytes: int, requested_part_size: int) -> int:
    """Choose the part size for a ``total_bytes`` multipart upload. Returns
    ``requested_part_size`` unless splitting at that size would exceed the
    server's 10,000-part cap, in which case it grows the part size (rounded up to
    a whole MiB) so the body fits in <= 10,000 parts — mirroring boto3's
    chunk-size adjustment. Parts only ever get larger, so they stay above the
    5 MiB floor."""
    if (total_bytes + requested_part_size - 1) // requested_part_size <= _MAX_PARTS_PER_UPLOAD:
        return requested_part_size
    mib = 1024 * 1024
    needed = (total_bytes + _MAX_PARTS_PER_UPLOAD - 1) // _MAX_PARTS_PER_UPLOAD
    return ((needed + mib - 1) // mib) * mib


class _Disk:
    """A single Archil disk. Per-disk operations are methods here, mirroring the
    JS SDK. A ``Disk`` also doubles as an S3-compatible bucket — read, write,
    delete, and list its files by key without mounting it.

    Every method is available both synchronously and asynchronously: call it
    directly to block (``disk.put_object(...)``), or use the ``.aio`` attribute
    to get a coroutine (``await disk.put_object.aio(...)``)."""

    def __init__(self, transport: _Transport, region: str, data: DiskData) -> None:
        self._transport = transport
        self._archil_region = region
        self._data = data

    def __repr__(self) -> str:
        return f"Disk(id={self._data.id!r}, name={self._data.name!r}, status={self._data.status!r})"

    # --- Disk fields (read-only) -------------------------------------------

    @property
    def id(self) -> str:
        return self._data.id

    @property
    def name(self) -> str:
        return self._data.name

    @property
    def organization(self) -> str:
        return self._data.organization

    @property
    def status(self) -> DiskStatus:
        return self._data.status

    @property
    def provider(self) -> str:
        return self._data.provider

    @property
    def region(self) -> str:
        return self._data.region

    @property
    def created_at(self) -> str:
        return self._data.created_at

    @property
    def fs_handler_status(self) -> Optional[str]:
        return self._data.fs_handler_status

    @property
    def last_accessed(self) -> Optional[str]:
        return self._data.last_accessed

    @property
    def active_data_bytes(self) -> Optional[int]:
        return self._data.active_data_bytes

    @property
    def total_data_bytes(self) -> Optional[int]:
        return self._data.total_data_bytes

    @property
    def monthly_usage(self) -> Optional[str]:
        return self._data.monthly_usage

    @property
    def mounts(self) -> Optional[list[MountResponse]]:
        return self._data.mounts

    @property
    def metrics(self) -> Optional[DiskMetrics]:
        return self._data.metrics

    @property
    def connected_clients(self) -> Optional[list[ConnectedClient]]:
        return self._data.connected_clients

    @property
    def authorized_users(self) -> Optional[list[AuthorizedUser]]:
        return self._data.authorized_users

    @property
    def allowed_ips(self) -> Optional[list[str]]:
        return self._data.allowed_ips

    @property
    def capabilities(self) -> Optional[list[str]]:
        return self._data.capabilities

    # --- User & access management ------------------------------------------

    async def add_user(self, user: Union[DiskUser, dict]) -> AuthorizedUser:
        data = await self._transport.request_json(
            "POST", f"/api/disks/{self.id}/users", json=_user_payload(user)
        )
        return AuthorizedUser.from_json(data)

    async def remove_user(self, user_type: Literal["token", "awssts"], identifier: str) -> None:
        await self._transport.request_empty(
            "DELETE",
            f"/api/disks/{self.id}/users/{user_type}",
            params={"identifier": identifier},
        )

    async def create_token(self, nickname: str) -> AuthorizedUser:
        """Create a token user and return it, including the one-time ``token`` and
        its ``identifier``. The token is shown exactly once."""
        data = await self._transport.request_json(
            "POST", f"/api/disks/{self.id}/users", json={"type": "token", "nickname": nickname}
        )
        user = AuthorizedUser.from_json(data)
        if not user.token or not user.identifier:
            raise RuntimeError("Server did not return a generated token")
        return user

    async def remove_token_user(self, identifier: str) -> None:
        await self.remove_user("token", identifier)

    async def list_delegations(self) -> list[Delegation]:
        """List the delegations currently held on this disk."""
        data = await self._transport.request_json(
            "GET", f"/api/disks/{self.id}/delegations"
        )
        return [Delegation.from_json(d) for d in data["delegations"]]

    async def revoke_delegation(self, delegation: Delegation) -> None:
        """Forcibly revoke a delegation identified by its client and inode."""
        await self._transport.request_empty(
            "POST",
            f"/api/disks/{self.id}/revoke-delegation",
            json={
                "clientId": delegation.client_id,
                "inodeId": delegation.inode_id,
            },
        )

    async def get_allowed_ips(self) -> list[str]:
        data = await self._transport.request_json("GET", f"/api/disks/{self.id}/allowed-ips")
        # `or []`: an empty allowlist can serialize as JSON `null`; callers
        # (add/remove_allowed_ip) iterate the result, so never hand back None.
        return (data or {}).get("allowedIps") or []

    async def set_allowed_ips(self, allowed_ips: list[str]) -> list[str]:
        data = await self._transport.request_json(
            "PUT", f"/api/disks/{self.id}/allowed-ips", json={"allowedIps": allowed_ips}
        )
        return (data or {}).get("allowedIps") or []

    async def add_allowed_ip(self, ip: str) -> list[str]:
        current = await self.get_allowed_ips()
        if ip in current:
            return current
        return await self.set_allowed_ips([*current, ip])

    async def remove_allowed_ip(self, ip: str) -> list[str]:
        current = await self.get_allowed_ips()
        return await self.set_allowed_ips([i for i in current if i != ip])

    async def delete(self) -> None:
        await self._transport.request_empty("DELETE", f"/api/disks/{self.id}")

    async def refresh(self) -> "_Disk":
        """Re-fetch this disk and return a fresh snapshot. A ``Disk`` is immutable,
        so the returned object reflects the current state — the original is
        unchanged. Rebind: ``disk = disk.refresh()``."""
        data = await self._transport.request_json("GET", f"/api/disks/{self.id}")
        return _Disk(self._transport, self._archil_region, DiskData.from_json(data))

    async def wait_until_ready(
        self, *, timeout: float = 300.0, poll_interval: float = 2.0
    ) -> "_Disk":
        """Poll until this disk reaches ``available`` and return the ready
        snapshot. Raises ``RuntimeError`` if it reaches a terminal failure state
        (``failed`` / ``deleted``) and ``TimeoutError`` if it isn't ready within
        ``timeout`` seconds.

        Async: ``disk = await disk.wait_until_ready.aio()``."""
        deadline = time.monotonic() + timeout
        disk = self
        while True:
            if disk.status == "available":
                return disk
            if disk.status in ("failed", "deleted", "deleting"):
                raise RuntimeError(f"Disk {disk.id} reached terminal status {disk.status!r}")
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Disk {disk.id} not ready after {timeout}s (status {disk.status!r})"
                )
            await asyncio.sleep(poll_interval)
            disk = await disk.refresh()

    # --- Compute -----------------------------------------------------------

    async def exec(self, command: str) -> ExecResult:
        """Execute a command in a container with this disk mounted. Blocks until
        the command completes and returns stdout, stderr, and exit code."""
        data = await self._transport.request_json(
            "POST", f"/api/disks/{self.id}/exec", json={"command": command}
        )
        return ExecResult.from_json(data)

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
        """Constant-time parallel grep across files on this disk. The returned
        ``stopped_reason`` says whether the search ran to completion or
        short-circuited on ``max_results`` / ``max_duration_seconds``."""
        data = await self._transport.request_json(
            "POST",
            f"/api/disks/{self.id}/grep",
            json={
                "directory": directory,
                "pattern": pattern,
                "recursive": recursive,
                "maxDurationSeconds": max_duration_seconds,
                "concurrency": concurrency,
                "maxResults": max_results,
            },
        )
        return GrepResult.from_json(data)

    # --- Sharing -----------------------------------------------------------

    async def share(self, key: str, *, expires_in: Optional[int] = None) -> ShareUrl:
        """Create a signed, time-limited URL that lets anyone download a single
        file from this disk without authentication. The returned URL embeds a
        cryptographically signed token carrying the disk, the file's key, and an
        expiry — share it directly; no API key is needed to redeem it.

        ``expires_in`` sets the URL lifetime in seconds (any positive integer,
        at most 604800 = 7 days). Defaults to 24 hours.

        Async: ``await disk.share.aio(key)``."""
        # The key and expiry travel in the JSON body, so keys containing "/" or
        # other reserved characters need no path/query encoding.
        body: dict = {"key": key}
        if expires_in is not None:
            body["expiresIn"] = expires_in
        data = await self._transport.request_json(
            "POST", f"/api/disks/{self.id}/share", json=body
        )
        return ShareUrl.from_json(data)

    # --- Agent tools -------------------------------------------------------

    def agent_tools(self, *, tools: Optional[List[str]] = None) -> "AgentToolset":
        """Build a filesystem toolset for this disk that drops into popular agent
        frameworks. The returned toolset exposes ``read_file``, ``write_file``,
        ``delete_file``, ``list_files``, ``grep``, and ``run_bash`` over the disk,
        which the tools address from a ``/`` root.

            agent = Agent(tools=disk.agent_tools().for_openai_agents())

        Pass ``tools`` to select a subset by name. This is a synchronous factory
        — the tools themselves are async and run on the SDK's event loop."""
        from .agent_tools._toolset import AgentToolset
        from ._synchronizer import translate_out

        return AgentToolset(translate_out(self), tools)

    # --- S3-compatible object API ------------------------------------------

    async def get_object(self, key: str) -> bytes:
        """Read an object via the S3-compatible GetObject API and return its full
        contents as bytes. Raises ``ArchilS3Error`` (status 404, code "NoSuchKey")
        if the object does not exist — use ``head_object`` / ``object_exists`` to
        check existence without raising.

        Async: ``data = await disk.get_object.aio(key)``."""
        resp = await self._transport.s3_request("GET", self.id, key)
        if not resp.is_success:
            raise parse_s3_error("GetObject", resp.status_code, resp.reason_phrase, resp.text)
        return resp.content

    async def head_object(self, key: str) -> Optional[ObjectMetadata]:
        """Fetch an object's metadata (size, etag, content type, last-modified)
        without downloading its contents. Returns ``None`` if the object does not
        exist."""
        resp = await self._transport.s3_request("HEAD", self.id, key)
        if resp.status_code == 404:
            return None
        if not resp.is_success:
            raise parse_s3_error("HeadObject", resp.status_code, resp.reason_phrase, resp.text)
        return ObjectMetadata(
            size=_safe_int(resp.headers.get("content-length")),
            etag=resp.headers.get("etag"),
            content_type=resp.headers.get("content-type"),
            last_modified=_header_datetime(resp.headers.get("last-modified")),
        )

    async def object_exists(self, key: str) -> bool:
        return (await self.head_object(key)) is not None

    async def put_object(
        self,
        key: str,
        body: BodyType,
        content_type: Optional[str] = None,
        *,
        mode: Optional[int] = None,
        uid: Optional[int] = None,
        gid: Optional[int] = None,
        multipart_threshold: Optional[int] = None,
        part_size: Optional[int] = None,
        concurrency: int = _DEFAULT_UPLOAD_CONCURRENCY,
    ) -> PutObjectResult:
        """Write an object via the S3-compatible API. Handles any size: small
        bodies go through a single PutObject request; bodies larger than
        ``multipart_threshold`` (defaults to ``part_size``, i.e. 16 MiB) are
        uploaded as a multipart upload automatically — split into ``part_size``
        parts, uploaded with bounded ``concurrency`` (default 4), and assembled,
        aborting the upload if any part fails so nothing is left half-staged. For
        manual control over the multipart lifecycle, use ``disk.multipart``.

        Faster than exec for large files. Returns the entity tag the server
        assigned (a multipart upload's tag is S3's ``md5(concat(partMd5s))-N``
        form rather than a plain MD5). ``content_type`` is optional; when omitted
        no Content-Type header is sent and the gateway picks the default. Set
        ``multipart_threshold`` lower than ``part_size`` (e.g. 5 MiB) to start
        using multipart sooner, or very high to force a single PutObject.

        Optional ``mode`` / ``uid`` / ``gid`` set the POSIX attributes of the
        published file (e.g. ``mode=0o644, uid=1000, gid=1000`` for a non-root
        agent sandbox). Defaults are server-side (currently ``root:root`` mode
        ``0644``).

        Async: ``await disk.put_object.aio(key, body)``."""
        chunk_size = max(part_size or _DEFAULT_PART_SIZE, _MIN_PART_SIZE)
        threshold = multipart_threshold if multipart_threshold is not None else chunk_size
        data = _to_bytes(body)
        posix_headers = _posix_create_headers(mode, uid, gid)

        if len(data) <= threshold:
            resp = await self._transport.s3_request(
                "PUT",
                self.id,
                key,
                body=body,
                content_type=content_type,
                extra_headers=posix_headers,
            )
            if not resp.is_success:
                raise parse_s3_error("PutObject", resp.status_code, resp.reason_phrase, resp.text)
            return PutObjectResult(etag=resp.headers.get("etag"))

        return await self._put_multipart(
            key, data, content_type, chunk_size, max(1, concurrency), posix_headers
        )

    async def _put_multipart(
        self,
        key: str,
        data: bytes,
        content_type: Optional[str],
        chunk_size: int,
        concurrency: int,
        posix_headers: Optional[dict[str, str]] = None,
    ) -> PutObjectResult:
        """Upload ``data`` through the multipart lifecycle: split into ``chunk_size``
        parts, upload them with bounded concurrency, then complete — aborting the
        upload if any part fails so nothing is left half-staged."""
        size = len(data)
        # Grow the part size if the body would otherwise need more than the
        # server's 10,000-part cap — otherwise the upload fails at ``complete``.
        chunk_size = _effective_part_size(size, chunk_size)
        mp = self.multipart
        upload = await mp.create(key, content_type, extra_headers=posix_headers)
        try:
            part_count = (size + chunk_size - 1) // chunk_size
            semaphore = asyncio.Semaphore(concurrency)

            async def _upload(index: int) -> UploadPart:
                start = index * chunk_size
                chunk = data[start : min(start + chunk_size, size)]
                async with semaphore:
                    return await mp.upload_part(key, upload.upload_id, index + 1, chunk)

            parts = await asyncio.gather(*(_upload(i) for i in range(part_count)))
            done = await mp.complete(key, upload.upload_id, list(parts))
            return PutObjectResult(etag=done.etag)
        except BaseException:
            # Don't let a cleanup failure mask the original error.
            try:
                await mp.abort(key, upload.upload_id)
            except Exception:
                pass
            raise

    async def append_object(
        self,
        key: str,
        body: BodyType,
        content_type: Optional[str] = None,
        *,
        mode: Optional[int] = None,
        uid: Optional[int] = None,
        gid: Optional[int] = None,
    ) -> PutObjectResult:
        """Append bytes to an object via the S3-compatible PutObject append
        extension (``?append=true``). If the object exists the bytes are appended
        to it; if it doesn't, it is created. Returns the entity tag of the full
        object after the append.

        Each call may append at most 1 MiB — the server rejects a larger body with
        ``EntityTooLarge``. To grow an object past that, append in chunks (or use
        ``put_object`` for a one-shot large write).

        Unlike most operations this is NOT auto-retried on a transient error:
        append isn't idempotent, so retrying a succeeded-but-unacknowledged
        append would duplicate the bytes. On a transient failure, re-append
        yourself only after confirming the object's size.

        When the object does not yet exist, optional ``mode`` / ``uid`` / ``gid``
        set the POSIX attributes of the newly created file (same headers as
        ``put_object``). They are ignored when appending to an existing object.

        Async: ``await disk.append_object.aio(key, body)``."""
        resp = await self._transport.s3_request(
            "PUT",
            self.id,
            key,
            body=body,
            content_type=content_type,
            params={"append": "true"},
            retry=False,
            extra_headers=_posix_create_headers(mode, uid, gid),
        )
        if not resp.is_success:
            raise parse_s3_error("AppendObject", resp.status_code, resp.reason_phrase, resp.text)
        return PutObjectResult(etag=resp.headers.get("etag"))

    async def delete_object(self, key: str) -> None:
        """Delete an object via the S3-compatible DeleteObject API. Idempotent:
        deleting a key that doesn't exist resolves successfully, per S3
        semantics."""
        resp = await self._transport.s3_request("DELETE", self.id, key)
        # Idempotent: a 404 for an absent key is not an error.
        if not resp.is_success and resp.status_code != 404:
            raise parse_s3_error("DeleteObject", resp.status_code, resp.reason_phrase, resp.text)

    async def list_objects(
        self,
        prefix: Optional[str] = None,
        *,
        recursive: bool = False,
        single_page: bool = False,
        limit: Optional[int] = None,
        continuation_token: Optional[str] = None,
        start_after: Optional[str] = None,
    ) -> ListObjectsResult:
        """List objects via the S3-compatible ListObjectsV2 API. By default this
        follows continuation tokens until the listing is exhausted and returns
        every matching key. Use ``limit`` to cap the total, ``single_page`` for a
        single request, or ``list_objects_pages`` to stream pages.

        Async: ``await disk.list_objects.aio(prefix)``."""
        if single_page:
            return await self._list_objects_page(
                prefix, recursive=recursive, continuation_token=continuation_token, start_after=start_after
            )

        objects: list[S3Object] = []
        common_prefixes: list[str] = []
        seen_prefixes: set[str] = set()
        echoed_prefix: Optional[str] = None
        truncated = False

        async for page in self.list_objects_pages(
            prefix, recursive=recursive, continuation_token=continuation_token, start_after=start_after
        ):
            echoed_prefix = page.prefix
            for cp in page.common_prefixes:
                if cp not in seen_prefixes:
                    seen_prefixes.add(cp)
                    common_prefixes.append(cp)
            for obj in page.objects:
                if limit is not None and len(objects) >= limit:
                    truncated = True  # the cap cut the listing short — more may exist
                    return ListObjectsResult(
                        objects=objects,
                        common_prefixes=common_prefixes,
                        is_truncated=truncated,
                        key_count=len(objects),
                        prefix=echoed_prefix,
                    )
                objects.append(obj)

        return ListObjectsResult(
            objects=objects,
            common_prefixes=common_prefixes,
            is_truncated=truncated,
            key_count=len(objects),
            prefix=echoed_prefix,
        )

    async def list_objects_pages(
        self,
        prefix: Optional[str] = None,
        *,
        recursive: bool = False,
        continuation_token: Optional[str] = None,
        start_after: Optional[str] = None,
    ) -> AsyncIterator[ListObjectsResult]:
        """Yield ListObjectsV2 pages lazily, following continuation tokens — a
        memory-friendly way to process a large listing without materializing it.
        ``limit`` / ``single_page`` don't apply here; control your own loop.

        Sync iteration: ``for page in disk.list_objects_pages(prefix): ...``.
        Async iteration: ``async for page in disk.list_objects_pages.aio(prefix): ...``."""
        seen_tokens: set[str] = set()
        token = continuation_token
        while True:
            page = await self._list_objects_page(
                prefix, recursive=recursive, continuation_token=token, start_after=start_after
            )
            yield page
            nxt = page.next_continuation_token if page.is_truncated else None
            # Stop at the end, or if the server returns a repeated token (no
            # forward progress) — never loop forever.
            if not nxt or nxt in seen_tokens:
                break
            seen_tokens.add(nxt)
            token = nxt

    async def _list_objects_page(
        self,
        prefix: Optional[str],
        *,
        recursive: bool,
        continuation_token: Optional[str],
        start_after: Optional[str],
    ) -> ListObjectsResult:
        params: dict[str, Union[str, int]] = {"list-type": 2}
        if prefix is not None:
            params["prefix"] = prefix
        # Non-recursive (default) lists a single level via the "/" delimiter;
        # recursive omits the delimiter so all keys under the prefix are returned.
        if not recursive:
            params["delimiter"] = "/"
        if continuation_token is not None:
            params["continuation-token"] = continuation_token
        if start_after is not None:
            params["start-after"] = start_after

        resp = await self._transport.s3_request("GET", self.id, "", params=params)
        if not resp.is_success:
            raise parse_s3_error("ListObjectsV2", resp.status_code, resp.reason_phrase, resp.text)

        # A 200 with a truncated or non-XML body must surface as a structured
        # ArchilS3Error, not an uncaught ParseError.
        try:
            parsed = parse_list_objects(resp.text)
        except ParseError as exc:
            raise ArchilS3Error(
                operation="ListObjectsV2",
                status_code=resp.status_code,
                message=f"malformed ListObjectsV2 XML response: {exc}",
                raw=resp.text,
            ) from exc
        objects = [
            S3Object(
                key=o["key"], size=o["size"], etag=o["etag"], last_modified=o["last_modified"]
            )
            for o in parsed["objects"]
        ]
        return ListObjectsResult(
            objects=objects,
            common_prefixes=parsed["common_prefixes"],
            is_truncated=parsed["is_truncated"],
            key_count=parsed["key_count"] if parsed["key_count"] is not None else len(objects),
            next_continuation_token=parsed["next_continuation_token"],
            prefix=parsed["prefix"],
        )

    # --- S3 bulk delete -----------------------------------------------------

    async def delete_objects(
        self, keys: list[str], *, quiet: bool = False
    ) -> DeleteObjectsResult:
        """Delete many objects in one S3-compatible DeleteObjects request. Unlike
        ``delete_object``, failures are reported per key rather than raised: the
        result's ``deleted`` lists the keys removed and ``errors`` lists the ones
        that weren't. A key that didn't exist still counts as deleted, per S3.

        The server caps a request at 1000 keys; larger inputs are split into
        1000-key batches transparently and the results merged. ``quiet`` omits
        the per-key success list server-side (``deleted`` comes back empty).

        Async: ``await disk.delete_objects.aio(keys)``."""
        deleted: list[str] = []
        errors: list[DeleteObjectsError] = []
        for i in range(0, len(keys), _MAX_DELETE_OBJECTS_PER_REQUEST):
            batch = keys[i : i + _MAX_DELETE_OBJECTS_PER_REQUEST]
            resp = await self._transport.s3_request(
                "POST",
                self.id,
                "",
                body=build_delete_request(batch, quiet),
                content_type="application/xml",
                params={"delete": ""},
            )
            if not resp.is_success:
                raise parse_s3_error(
                    "DeleteObjects", resp.status_code, resp.reason_phrase, resp.text
                )
            try:
                parsed = parse_delete_result(resp.text)
            except ParseError as exc:
                raise ArchilS3Error(
                    operation="DeleteObjects",
                    status_code=resp.status_code,
                    message=f"malformed DeleteObjects XML response: {exc}",
                    raw=resp.text,
                ) from exc
            deleted.extend(parsed["deleted"])
            errors.extend(
                DeleteObjectsError(key=e["key"], code=e["code"], message=e["message"])
                for e in parsed["errors"]
            )
        return DeleteObjectsResult(deleted=deleted, errors=errors)

    @property
    def multipart(self) -> "_DiskMultipart":
        """The advanced, opt-in multipart-upload API. Drive the raw lifecycle
        yourself — ``create`` -> ``upload_part`` -> ``complete`` (or ``abort``),
        plus ``list_parts`` / ``list_uploads``. Most callers don't need this:
        ``put_object`` runs the whole lifecycle automatically for large bodies.
        Reach for it only when you need manual control (e.g. uploading parts from
        separate processes), and note you then own part-size, memory, and
        concurrency management."""
        return _DiskMultipart(self)


class _DiskMultipart:
    """The advanced, opt-in multipart-upload namespace, reached via ``disk.multipart``.
    Drives the raw S3 multipart lifecycle. Prefer ``disk.put_object``, which runs
    this lifecycle automatically for large bodies; use this only for manual
    control, in which case you own part-size, memory, and concurrency management.

    Every method is available both synchronously and asynchronously: call it
    directly to block (``disk.multipart.create(...)``) or use ``.aio`` for a
    coroutine (``await disk.multipart.create.aio(...)``)."""

    def __init__(self, disk: "_Disk") -> None:
        self._disk = disk

    def __repr__(self) -> str:
        return f"Multipart(disk={self._disk.id!r})"

    async def create(
        self,
        key: str,
        content_type: Optional[str] = None,
        *,
        mode: Optional[int] = None,
        uid: Optional[int] = None,
        gid: Optional[int] = None,
        extra_headers: Optional[dict[str, str]] = None,
    ) -> MultipartUpload:
        """Start a multipart upload (CreateMultipartUpload) and return its
        ``upload_id``. Upload parts with ``upload_part``, then assemble with
        ``complete`` (or discard with ``abort``).

        Optional ``mode`` / ``uid`` / ``gid`` (or a prebuilt ``extra_headers``
        map) set the POSIX attributes of the completed object."""
        headers = dict(extra_headers or {})
        posix = _posix_create_headers(mode, uid, gid)
        if posix:
            headers.update(posix)
        resp = await self._disk._transport.s3_request(
            "POST",
            self._disk.id,
            key,
            content_type=content_type,
            params={"uploads": ""},
            extra_headers=headers or None,
        )
        if not resp.is_success:
            raise parse_s3_error(
                "CreateMultipartUpload", resp.status_code, resp.reason_phrase, resp.text
            )
        try:
            parsed = parse_initiate_multipart_upload(resp.text)
        except ParseError as exc:
            raise ArchilS3Error(
                operation="CreateMultipartUpload",
                status_code=resp.status_code,
                message=f"malformed InitiateMultipartUpload XML response: {exc}",
                raw=resp.text,
            ) from exc
        upload_id = parsed["upload_id"]
        if not upload_id:
            raise ArchilS3Error(
                operation="CreateMultipartUpload",
                status_code=resp.status_code,
                message="response did not contain an UploadId",
                raw=resp.text,
            )
        return MultipartUpload(
            upload_id=upload_id,
            key=parsed["key"] or key,
            bucket=parsed["bucket"] or self._disk.id,
        )

    async def upload_part(
        self, key: str, upload_id: str, part_number: int, body: BodyType
    ) -> UploadPart:
        """Upload one part (UploadPart) and return its entity tag, which you must
        collect (with its part number) and pass to ``complete``. Every part except
        the last must be at least 5 MiB."""
        resp = await self._disk._transport.s3_request(
            "PUT",
            self._disk.id,
            key,
            body=body,
            params={"uploadId": upload_id, "partNumber": part_number},
        )
        if not resp.is_success:
            raise parse_s3_error("UploadPart", resp.status_code, resp.reason_phrase, resp.text)
        return UploadPart(part_number=part_number, etag=resp.headers.get("etag") or "")

    async def complete(
        self, key: str, upload_id: str, parts: list[UploadPart]
    ) -> CompletedMultipartUpload:
        """Finish a multipart upload (CompleteMultipartUpload), assembling the
        listed parts into one object. Parts are sorted by part number before
        submission (the server requires strictly-increasing order).

        Unlike the other operations this is NOT auto-retried on a transient
        error: the gateway isn't idempotent for completion, so a retry after a
        successful-but-unacknowledged complete would return a spurious
        NoSuchUpload. Re-drive completion yourself only after confirming the
        object isn't already present."""
        ordered = sorted(parts, key=lambda p: p.part_number)
        resp = await self._disk._transport.s3_request(
            "POST",
            self._disk.id,
            key,
            body=build_complete_multipart_upload([(p.part_number, p.etag) for p in ordered]),
            content_type="application/xml",
            params={"uploadId": upload_id},
            retry=False,
        )
        if not resp.is_success:
            raise parse_s3_error(
                "CompleteMultipartUpload", resp.status_code, resp.reason_phrase, resp.text
            )
        try:
            parsed = parse_complete_multipart_upload(resp.text)
        except ParseError as exc:
            raise ArchilS3Error(
                operation="CompleteMultipartUpload",
                status_code=resp.status_code,
                message=f"malformed CompleteMultipartUpload XML response: {exc}",
                raw=resp.text,
            ) from exc
        return CompletedMultipartUpload(
            etag=parsed["etag"],
            location=parsed["location"],
            bucket=parsed["bucket"],
            key=parsed["key"],
        )

    async def abort(self, key: str, upload_id: str) -> None:
        """Abort a multipart upload (AbortMultipartUpload), discarding every staged
        part. Idempotent against an upload that's already gone (404 / NoSuchUpload
        resolves successfully)."""
        resp = await self._disk._transport.s3_request(
            "DELETE", self._disk.id, key, params={"uploadId": upload_id}
        )
        if not resp.is_success and resp.status_code != 404:
            raise parse_s3_error(
                "AbortMultipartUpload", resp.status_code, resp.reason_phrase, resp.text
            )

    async def list_parts(
        self,
        key: str,
        upload_id: str,
        *,
        max_parts: Optional[int] = None,
        part_number_marker: Optional[int] = None,
    ) -> PartListing:
        """List the parts already uploaded for an in-progress upload (ListParts).
        Returns a single page; follow ``next_part_number_marker`` (when
        ``is_truncated``) to page through the rest."""
        params: dict[str, Union[str, int]] = {"uploadId": upload_id}
        if max_parts is not None:
            params["max-parts"] = max_parts
        if part_number_marker is not None:
            params["part-number-marker"] = part_number_marker
        resp = await self._disk._transport.s3_request("GET", self._disk.id, key, params=params)
        if not resp.is_success:
            raise parse_s3_error("ListParts", resp.status_code, resp.reason_phrase, resp.text)
        try:
            parsed = parse_list_parts(resp.text)
        except ParseError as exc:
            raise ArchilS3Error(
                operation="ListParts",
                status_code=resp.status_code,
                message=f"malformed ListParts XML response: {exc}",
                raw=resp.text,
            ) from exc
        parts = [
            PartInfo(
                part_number=p["part_number"],
                size=p["size"],
                etag=p["etag"],
                last_modified=p["last_modified"],
            )
            for p in parsed["parts"]
        ]
        return PartListing(
            parts=parts,
            is_truncated=parsed["is_truncated"],
            part_number_marker=parsed["part_number_marker"],
            max_parts=parsed["max_parts"],
            bucket=parsed["bucket"],
            key=parsed["key"],
            upload_id=parsed["upload_id"],
            next_part_number_marker=parsed["next_part_number_marker"],
        )

    async def list_uploads(
        self,
        *,
        prefix: Optional[str] = None,
        delimiter: Optional[str] = None,
        key_marker: Optional[str] = None,
        upload_id_marker: Optional[str] = None,
        max_uploads: Optional[int] = None,
    ) -> MultipartUploadListing:
        """List in-progress multipart uploads on the disk (ListMultipartUploads).
        Returns a single page; follow ``next_key_marker`` / ``next_upload_id_marker``
        (when ``is_truncated``) for the rest."""
        params: dict[str, Union[str, int]] = {"uploads": ""}
        if prefix is not None:
            params["prefix"] = prefix
        if delimiter is not None:
            params["delimiter"] = delimiter
        if key_marker is not None:
            params["key-marker"] = key_marker
        if upload_id_marker is not None:
            params["upload-id-marker"] = upload_id_marker
        if max_uploads is not None:
            params["max-uploads"] = max_uploads
        resp = await self._disk._transport.s3_request("GET", self._disk.id, "", params=params)
        if not resp.is_success:
            raise parse_s3_error(
                "ListMultipartUploads", resp.status_code, resp.reason_phrase, resp.text
            )
        try:
            parsed = parse_list_multipart_uploads(resp.text)
        except ParseError as exc:
            raise ArchilS3Error(
                operation="ListMultipartUploads",
                status_code=resp.status_code,
                message=f"malformed ListMultipartUploads XML response: {exc}",
                raw=resp.text,
            ) from exc
        uploads = [
            MultipartUploadSummary(
                key=u["key"], upload_id=u["upload_id"], initiated=u["initiated"]
            )
            for u in parsed["uploads"]
        ]
        return MultipartUploadListing(
            uploads=uploads,
            common_prefixes=parsed["common_prefixes"],
            is_truncated=parsed["is_truncated"],
            bucket=parsed["bucket"],
            key_marker=parsed["key_marker"],
            upload_id_marker=parsed["upload_id_marker"],
            next_key_marker=parsed["next_key_marker"],
            next_upload_id_marker=parsed["next_upload_id_marker"],
            prefix=parsed["prefix"],
            delimiter=parsed["delimiter"],
            max_uploads=parsed["max_uploads"],
        )
