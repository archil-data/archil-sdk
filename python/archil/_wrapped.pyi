import archil._archil
import archil._http
import archil._models
import archil._workspace
import archil.agent_tools._toolset
import typing
import typing_extensions

class Archil:
    """Top-level Archil client. Holds the account-level ``disks`` and ``tokens``
    collections and the cross-disk ``exec``. Construct directly for multi-account
    or multi-region scripts; otherwise use the module-level helpers.

    Every method is available both synchronously and asynchronously: call it
    directly to block, or use the ``.aio`` attribute for a coroutine
    (e.g. ``await archil.exec.aio(...)``). Also usable as an (async) context
    manager: ``with Archil(...) as a:`` / ``async with Archil(...) as a:``.
    """
    def __init__(self, *, api_key: typing.Optional[str] = None, region: typing.Optional[str] = None, base_url: typing.Optional[str] = None, s3_base_url: typing.Optional[str] = None, timeout: typing.Optional[float] = 30.0, _http_transport=None) -> None:
        ...

    @property
    def disks(self) -> Disks:
        ...

    @property
    def tokens(self) -> Tokens:
        ...

    class __exec_spec(typing_extensions.Protocol):
        def __call__(self, /, *, disks: dict[str, typing.Union[object, str, archil._archil.ExecMountSpec]], command: str) -> archil._models.ExecResult:
            """Run a command in a container with multiple disks mounted
            simultaneously, each at its own relative path under ``/mnt/archil``.
            Blocks until the command completes and returns its stdout, stderr, exit
            code, and timing.
            """
            ...

        async def aio(self, /, *, disks: dict[str, typing.Union[object, str, archil._archil.ExecMountSpec]], command: str) -> archil._models.ExecResult:
            """Run a command in a container with multiple disks mounted
            simultaneously, each at its own relative path under ``/mnt/archil``.
            Blocks until the command completes and returns its stdout, stderr, exit
            code, and timing.
            """
            ...

    exec: __exec_spec

    def workspace(self, mounts: dict[str, typing.Union[object, str, archil._archil.ExecMountSpec]]) -> Workspace:
        """Build a :class:`Workspace`: a filesystem spanning several disks at once.

        ``mounts`` maps a relative path to a disk (or ``ExecMountSpec``), exactly
        like :meth:`exec`; each disk appears as a top-level directory. The
        workspace is a full filesystem — ``read_file`` / ``write_file`` /
        ``list_files`` / ``grep`` / ``exec`` route to the right disk by path, and
        ``grep`` / ``list_files`` fan out across all of them — and
        ``agent_tools()`` builds drop-in agent tools just like :meth:`Disk`::

            ws = archil.workspace({"data": disk_a, "cache": disk_b})
            agent = Agent(tools=ws.agent_tools().for_langchain())
        """
        ...

    class __close_spec(typing_extensions.Protocol):
        def __call__(self, /) -> None:
            """Close the underlying HTTP connections. Optional — also usable as a
            context manager (``with Archil(...) as archil:``).
            """
            ...

        async def aio(self, /) -> None:
            """Close the underlying HTTP connections. Optional — also usable as a
            context manager (``with Archil(...) as archil:``).
            """
            ...

    close: __close_spec

    def __enter__(self) -> Archil:
        ...

    async def __aenter__(self) -> Archil:
        ...

    def __exit__(self, exc_type, exc, tb) -> None:
        ...

    async def __aexit__(self, exc_type, exc, tb) -> None:
        ...


class Disks:
    """Account-level disk collection: list, look up, and create disks.

    Every method is available both synchronously and asynchronously — call it
    directly to block, or use ``.aio`` for a coroutine
    (e.g. ``await archil.disks.get.aio(disk_id)``).
    """
    def __init__(self, transport: archil._http._Transport, region: str) -> None:
        ...

    class ___page_spec(typing_extensions.Protocol):
        def __call__(self, /, *, limit: typing.Optional[int], cursor: typing.Optional[str], name: typing.Optional[str] = None) -> tuple[list[Disk], typing.Optional[str]]:
            ...

        async def aio(self, /, *, limit: typing.Optional[int], cursor: typing.Optional[str], name: typing.Optional[str] = None) -> tuple[list[Disk], typing.Optional[str]]:
            ...

    _page: ___page_spec

    class __list_spec(typing_extensions.Protocol):
        def __call__(self, /, *, limit: typing.Optional[int] = None, cursor: typing.Optional[str] = None, name: typing.Optional[str] = None) -> list[Disk]:
            """List the account's disks. Fetches in cursor-driven pages (bounded
            server work per request) and follows ``nextCursor`` until exhausted, so
            the returned list is complete even for very large accounts. Use ``limit``
            to cap the total, or ``list_pages`` to walk pages yourself.

            Async: ``await archil.disks.list.aio()``.
            """
            ...

        async def aio(self, /, *, limit: typing.Optional[int] = None, cursor: typing.Optional[str] = None, name: typing.Optional[str] = None) -> list[Disk]:
            """List the account's disks. Fetches in cursor-driven pages (bounded
            server work per request) and follows ``nextCursor`` until exhausted, so
            the returned list is complete even for very large accounts. Use ``limit``
            to cap the total, or ``list_pages`` to walk pages yourself.

            Async: ``await archil.disks.list.aio()``.
            """
            ...

    list: __list_spec

    class __list_pages_spec(typing_extensions.Protocol):
        def __call__(self, /, *, cursor: typing.Optional[str] = None, page_size: typing.Optional[int] = None) -> typing.Iterator[archil._models.DiskPage]:
            """Yield pages of disks lazily, following ``nextCursor`` — each page's
            ``next_cursor`` can also be persisted to resume listing later.

            Sync iteration: ``for page in archil.disks.list_pages(): ...``.
            Async iteration: ``async for page in archil.disks.list_pages.aio(): ...``.
            """
            ...

        def aio(self, /, *, cursor: typing.Optional[str] = None, page_size: typing.Optional[int] = None) -> typing.AsyncIterator[archil._models.DiskPage]:
            """Yield pages of disks lazily, following ``nextCursor`` — each page's
            ``next_cursor`` can also be persisted to resume listing later.

            Sync iteration: ``for page in archil.disks.list_pages(): ...``.
            Async iteration: ``async for page in archil.disks.list_pages.aio(): ...``.
            """
            ...

    list_pages: __list_pages_spec

    class __get_spec(typing_extensions.Protocol):
        def __call__(self, /, id: str) -> Disk:
            ...

        async def aio(self, /, id: str) -> Disk:
            ...

    get: __get_spec

    class __create_spec(typing_extensions.Protocol):
        def __call__(self, /, *, name: str, mounts: typing.Optional[typing.Sequence[typing.Union[archil._models.S3Mount, archil._models.GCSMount, archil._models.R2Mount, archil._models.S3CompatibleMount, archil._models.AzureBlobMount]]] = None, allowed_ips: typing.Optional[list[str]] = None, root_attrs: typing.Optional[archil._models.RootAttrs] = None) -> archil._models.CreateDiskResult:
            """Create a new disk with an auto-generated mount token.

            Returns the Disk, the one-time token (save it — it cannot be retrieved
            again), and the token identifier for later management.

            ``root_attrs`` sets the POSIX owner and mode of the disk's root
            directory (e.g. ``RootAttrs(uid=1000, gid=1000, mode=0o755)`` so an
            unprivileged process can create entries under the mount root without
            a post-mount ``chown``). Creation-time only.
            """
            ...

        async def aio(self, /, *, name: str, mounts: typing.Optional[typing.Sequence[typing.Union[archil._models.S3Mount, archil._models.GCSMount, archil._models.R2Mount, archil._models.S3CompatibleMount, archil._models.AzureBlobMount]]] = None, allowed_ips: typing.Optional[list[str]] = None, root_attrs: typing.Optional[archil._models.RootAttrs] = None) -> archil._models.CreateDiskResult:
            """Create a new disk with an auto-generated mount token.

            Returns the Disk, the one-time token (save it — it cannot be retrieved
            again), and the token identifier for later management.

            ``root_attrs`` sets the POSIX owner and mode of the disk's root
            directory (e.g. ``RootAttrs(uid=1000, gid=1000, mode=0o755)`` so an
            unprivileged process can create entries under the mount root without
            a post-mount ``chown``). Creation-time only.
            """
            ...

    create: __create_spec


class Multipart:
    """The advanced, opt-in multipart-upload namespace, reached via ``disk.multipart``.
    Drives the raw S3 multipart lifecycle. Prefer ``disk.put_object``, which runs
    this lifecycle automatically for large bodies; use this only for manual
    control, in which case you own part-size, memory, and concurrency management.

    Every method is available both synchronously and asynchronously: call it
    directly to block (``disk.multipart.create(...)``) or use ``.aio`` for a
    coroutine (``await disk.multipart.create.aio(...)``).
    """
    def __init__(self, disk: Disk) -> None:
        ...

    def __repr__(self) -> str:
        ...

    class __create_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None, extra_headers: typing.Optional[dict[str, str]] = None) -> archil._models.MultipartUpload:
            """Start a multipart upload (CreateMultipartUpload) and return its
            ``upload_id``. Upload parts with ``upload_part``, then assemble with
            ``complete`` (or discard with ``abort``).

            Optional ``mode`` / ``uid`` / ``gid`` (or a prebuilt ``extra_headers``
            map) set the POSIX attributes of the completed object.
            """
            ...

        async def aio(self, /, key: str, content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None, extra_headers: typing.Optional[dict[str, str]] = None) -> archil._models.MultipartUpload:
            """Start a multipart upload (CreateMultipartUpload) and return its
            ``upload_id``. Upload parts with ``upload_part``, then assemble with
            ``complete`` (or discard with ``abort``).

            Optional ``mode`` / ``uid`` / ``gid`` (or a prebuilt ``extra_headers``
            map) set the POSIX attributes of the completed object.
            """
            ...

    create: __create_spec

    class __upload_part_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, upload_id: str, part_number: int, body: typing.Union[str, bytes, bytearray, memoryview]) -> archil._models.UploadPart:
            """Upload one part (UploadPart) and return its entity tag, which you must
            collect (with its part number) and pass to ``complete``. Every part except
            the last must be at least 5 MiB.
            """
            ...

        async def aio(self, /, key: str, upload_id: str, part_number: int, body: typing.Union[str, bytes, bytearray, memoryview]) -> archil._models.UploadPart:
            """Upload one part (UploadPart) and return its entity tag, which you must
            collect (with its part number) and pass to ``complete``. Every part except
            the last must be at least 5 MiB.
            """
            ...

    upload_part: __upload_part_spec

    class __complete_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, upload_id: str, parts: list[archil._models.UploadPart]) -> archil._models.CompletedMultipartUpload:
            """Finish a multipart upload (CompleteMultipartUpload), assembling the
            listed parts into one object. Parts are sorted by part number before
            submission (the server requires strictly-increasing order).

            Unlike the other operations this is NOT auto-retried on a transient
            error: the gateway isn't idempotent for completion, so a retry after a
            successful-but-unacknowledged complete would return a spurious
            NoSuchUpload. Re-drive completion yourself only after confirming the
            object isn't already present.
            """
            ...

        async def aio(self, /, key: str, upload_id: str, parts: list[archil._models.UploadPart]) -> archil._models.CompletedMultipartUpload:
            """Finish a multipart upload (CompleteMultipartUpload), assembling the
            listed parts into one object. Parts are sorted by part number before
            submission (the server requires strictly-increasing order).

            Unlike the other operations this is NOT auto-retried on a transient
            error: the gateway isn't idempotent for completion, so a retry after a
            successful-but-unacknowledged complete would return a spurious
            NoSuchUpload. Re-drive completion yourself only after confirming the
            object isn't already present.
            """
            ...

    complete: __complete_spec

    class __abort_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, upload_id: str) -> None:
            """Abort a multipart upload (AbortMultipartUpload), discarding every staged
            part. Idempotent against an upload that's already gone (404 / NoSuchUpload
            resolves successfully).
            """
            ...

        async def aio(self, /, key: str, upload_id: str) -> None:
            """Abort a multipart upload (AbortMultipartUpload), discarding every staged
            part. Idempotent against an upload that's already gone (404 / NoSuchUpload
            resolves successfully).
            """
            ...

    abort: __abort_spec

    class __list_parts_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, upload_id: str, *, max_parts: typing.Optional[int] = None, part_number_marker: typing.Optional[int] = None) -> archil._models.PartListing:
            """List the parts already uploaded for an in-progress upload (ListParts).
            Returns a single page; follow ``next_part_number_marker`` (when
            ``is_truncated``) to page through the rest.
            """
            ...

        async def aio(self, /, key: str, upload_id: str, *, max_parts: typing.Optional[int] = None, part_number_marker: typing.Optional[int] = None) -> archil._models.PartListing:
            """List the parts already uploaded for an in-progress upload (ListParts).
            Returns a single page; follow ``next_part_number_marker`` (when
            ``is_truncated``) to page through the rest.
            """
            ...

    list_parts: __list_parts_spec

    class __list_uploads_spec(typing_extensions.Protocol):
        def __call__(self, /, *, prefix: typing.Optional[str] = None, delimiter: typing.Optional[str] = None, key_marker: typing.Optional[str] = None, upload_id_marker: typing.Optional[str] = None, max_uploads: typing.Optional[int] = None) -> archil._models.MultipartUploadListing:
            """List in-progress multipart uploads on the disk (ListMultipartUploads).
            Returns a single page; follow ``next_key_marker`` / ``next_upload_id_marker``
            (when ``is_truncated``) for the rest.
            """
            ...

        async def aio(self, /, *, prefix: typing.Optional[str] = None, delimiter: typing.Optional[str] = None, key_marker: typing.Optional[str] = None, upload_id_marker: typing.Optional[str] = None, max_uploads: typing.Optional[int] = None) -> archil._models.MultipartUploadListing:
            """List in-progress multipart uploads on the disk (ListMultipartUploads).
            Returns a single page; follow ``next_key_marker`` / ``next_upload_id_marker``
            (when ``is_truncated``) for the rest.
            """
            ...

    list_uploads: __list_uploads_spec


class Disk:
    """A single Archil disk. Per-disk operations are methods here, mirroring the
    JS SDK. A ``Disk`` also doubles as an S3-compatible bucket — read, write,
    delete, and list its files by key without mounting it.

    Every method is available both synchronously and asynchronously: call it
    directly to block (``disk.put_object(...)``), or use the ``.aio`` attribute
    to get a coroutine (``await disk.put_object.aio(...)``).
    """
    def __init__(self, transport: archil._http._Transport, region: str, data: archil._models.DiskData) -> None:
        ...

    def __repr__(self) -> str:
        ...

    @property
    def id(self) -> str:
        ...

    @property
    def name(self) -> str:
        ...

    @property
    def organization(self) -> str:
        ...

    @property
    def status(self) -> typing.Literal['available', 'creating', 'deleting', 'deleted', 'failed']:
        ...

    @property
    def provider(self) -> str:
        ...

    @property
    def region(self) -> str:
        ...

    @property
    def created_at(self) -> str:
        ...

    @property
    def fs_handler_status(self) -> typing.Optional[str]:
        ...

    @property
    def last_accessed(self) -> typing.Optional[str]:
        ...

    @property
    def active_data_bytes(self) -> typing.Optional[int]:
        ...

    @property
    def total_data_bytes(self) -> typing.Optional[int]:
        ...

    @property
    def monthly_usage(self) -> typing.Optional[str]:
        ...

    @property
    def mounts(self) -> typing.Optional[list[archil._models.MountResponse]]:
        ...

    @property
    def metrics(self) -> typing.Optional[archil._models.DiskMetrics]:
        ...

    @property
    def connected_clients(self) -> typing.Optional[list[archil._models.ConnectedClient]]:
        ...

    @property
    def authorized_users(self) -> typing.Optional[list[archil._models.AuthorizedUser]]:
        ...

    @property
    def allowed_ips(self) -> typing.Optional[list[str]]:
        ...

    @property
    def root_attrs(self) -> typing.Optional[archil._models.RootAttrs]:
        """Root-directory POSIX attributes recorded at creation, if any."""
        ...

    @property
    def capabilities(self) -> typing.Optional[list[str]]:
        ...

    class __add_user_spec(typing_extensions.Protocol):
        def __call__(self, /, user: typing.Union[archil._models.TokenUser, archil._models.AwsStsUser, dict]) -> archil._models.AuthorizedUser:
            ...

        async def aio(self, /, user: typing.Union[archil._models.TokenUser, archil._models.AwsStsUser, dict]) -> archil._models.AuthorizedUser:
            ...

    add_user: __add_user_spec

    class __remove_user_spec(typing_extensions.Protocol):
        def __call__(self, /, user_type: typing.Literal['token', 'awssts'], identifier: str) -> None:
            ...

        async def aio(self, /, user_type: typing.Literal['token', 'awssts'], identifier: str) -> None:
            ...

    remove_user: __remove_user_spec

    class __create_token_spec(typing_extensions.Protocol):
        def __call__(self, /, nickname: str) -> archil._models.AuthorizedUser:
            """Create a token user and return it, including the one-time ``token`` and
            its ``identifier``. The token is shown exactly once.
            """
            ...

        async def aio(self, /, nickname: str) -> archil._models.AuthorizedUser:
            """Create a token user and return it, including the one-time ``token`` and
            its ``identifier``. The token is shown exactly once.
            """
            ...

    create_token: __create_token_spec

    class __remove_token_user_spec(typing_extensions.Protocol):
        def __call__(self, /, identifier: str) -> None:
            ...

        async def aio(self, /, identifier: str) -> None:
            ...

    remove_token_user: __remove_token_user_spec

    class __list_delegations_spec(typing_extensions.Protocol):
        def __call__(self, /) -> list[archil._models.Delegation]:
            """List the delegations currently held on this disk."""
            ...

        async def aio(self, /) -> list[archil._models.Delegation]:
            """List the delegations currently held on this disk."""
            ...

    list_delegations: __list_delegations_spec

    class __revoke_delegation_spec(typing_extensions.Protocol):
        def __call__(self, /, delegation: archil._models.Delegation) -> None:
            """Forcibly revoke a delegation identified by its client and inode."""
            ...

        async def aio(self, /, delegation: archil._models.Delegation) -> None:
            """Forcibly revoke a delegation identified by its client and inode."""
            ...

    revoke_delegation: __revoke_delegation_spec

    class __get_allowed_ips_spec(typing_extensions.Protocol):
        def __call__(self, /) -> list[str]:
            ...

        async def aio(self, /) -> list[str]:
            ...

    get_allowed_ips: __get_allowed_ips_spec

    class __set_allowed_ips_spec(typing_extensions.Protocol):
        def __call__(self, /, allowed_ips: list[str]) -> list[str]:
            ...

        async def aio(self, /, allowed_ips: list[str]) -> list[str]:
            ...

    set_allowed_ips: __set_allowed_ips_spec

    class __add_allowed_ip_spec(typing_extensions.Protocol):
        def __call__(self, /, ip: str) -> list[str]:
            ...

        async def aio(self, /, ip: str) -> list[str]:
            ...

    add_allowed_ip: __add_allowed_ip_spec

    class __remove_allowed_ip_spec(typing_extensions.Protocol):
        def __call__(self, /, ip: str) -> list[str]:
            ...

        async def aio(self, /, ip: str) -> list[str]:
            ...

    remove_allowed_ip: __remove_allowed_ip_spec

    class __delete_spec(typing_extensions.Protocol):
        def __call__(self, /) -> None:
            ...

        async def aio(self, /) -> None:
            ...

    delete: __delete_spec

    class __refresh_spec(typing_extensions.Protocol):
        def __call__(self, /) -> Disk:
            """Re-fetch this disk and return a fresh snapshot. A ``Disk`` is immutable,
            so the returned object reflects the current state — the original is
            unchanged. Rebind: ``disk = disk.refresh()``.
            """
            ...

        async def aio(self, /) -> Disk:
            """Re-fetch this disk and return a fresh snapshot. A ``Disk`` is immutable,
            so the returned object reflects the current state — the original is
            unchanged. Rebind: ``disk = disk.refresh()``.
            """
            ...

    refresh: __refresh_spec

    class __wait_until_ready_spec(typing_extensions.Protocol):
        def __call__(self, /, *, timeout: float = 300.0, poll_interval: float = 2.0) -> Disk:
            """Poll until this disk reaches ``available`` and return the ready
            snapshot. Raises ``RuntimeError`` if it reaches a terminal failure state
            (``failed`` / ``deleted``) and ``TimeoutError`` if it isn't ready within
            ``timeout`` seconds.

            Async: ``disk = await disk.wait_until_ready.aio()``.
            """
            ...

        async def aio(self, /, *, timeout: float = 300.0, poll_interval: float = 2.0) -> Disk:
            """Poll until this disk reaches ``available`` and return the ready
            snapshot. Raises ``RuntimeError`` if it reaches a terminal failure state
            (``failed`` / ``deleted``) and ``TimeoutError`` if it isn't ready within
            ``timeout`` seconds.

            Async: ``disk = await disk.wait_until_ready.aio()``.
            """
            ...

    wait_until_ready: __wait_until_ready_spec

    class __exec_spec(typing_extensions.Protocol):
        def __call__(self, /, command: str) -> archil._models.ExecResult:
            """Execute a command in a container with this disk mounted. Blocks until
            the command completes and returns stdout, stderr, and exit code.
            """
            ...

        async def aio(self, /, command: str) -> archil._models.ExecResult:
            """Execute a command in a container with this disk mounted. Blocks until
            the command completes and returns stdout, stderr, and exit code.
            """
            ...

    exec: __exec_spec

    class __grep_spec(typing_extensions.Protocol):
        def __call__(self, /, *, directory: str, pattern: str, recursive: bool = False, max_duration_seconds: int = 30, concurrency: int = 50, max_results: int = 1000) -> archil._models.GrepResult:
            """Constant-time parallel grep across files on this disk. The returned
            ``stopped_reason`` says whether the search ran to completion or
            short-circuited on ``max_results`` / ``max_duration_seconds``.
            """
            ...

        async def aio(self, /, *, directory: str, pattern: str, recursive: bool = False, max_duration_seconds: int = 30, concurrency: int = 50, max_results: int = 1000) -> archil._models.GrepResult:
            """Constant-time parallel grep across files on this disk. The returned
            ``stopped_reason`` says whether the search ran to completion or
            short-circuited on ``max_results`` / ``max_duration_seconds``.
            """
            ...

    grep: __grep_spec

    class __share_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, *, expires_in: typing.Optional[int] = None) -> archil._models.ShareUrl:
            """Create a signed, time-limited URL that lets anyone download a single
            file from this disk without authentication. The returned URL embeds a
            cryptographically signed token carrying the disk, the file's key, and an
            expiry — share it directly; no API key is needed to redeem it.

            ``expires_in`` sets the URL lifetime in seconds (any positive integer,
            at most 604800 = 7 days). Defaults to 24 hours.

            Async: ``await disk.share.aio(key)``.
            """
            ...

        async def aio(self, /, key: str, *, expires_in: typing.Optional[int] = None) -> archil._models.ShareUrl:
            """Create a signed, time-limited URL that lets anyone download a single
            file from this disk without authentication. The returned URL embeds a
            cryptographically signed token carrying the disk, the file's key, and an
            expiry — share it directly; no API key is needed to redeem it.

            ``expires_in`` sets the URL lifetime in seconds (any positive integer,
            at most 604800 = 7 days). Defaults to 24 hours.

            Async: ``await disk.share.aio(key)``.
            """
            ...

    share: __share_spec

    def agent_tools(self, *, tools: typing.Optional[typing.List[str]] = None) -> archil.agent_tools._toolset.AgentToolset:
        """Build a filesystem toolset for this disk that drops into popular agent
        frameworks. The returned toolset exposes ``read_file``, ``write_file``,
        ``delete_file``, ``list_files``, ``grep``, and ``run_bash`` over the disk,
        which the tools address from a ``/`` root.

            agent = Agent(tools=disk.agent_tools().for_openai_agents())

        Pass ``tools`` to select a subset by name. This is a synchronous factory
        — the tools themselves are async and run on the SDK's event loop.
        """
        ...

    class __get_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str) -> bytes:
            """Read an object via the S3-compatible GetObject API and return its full
            contents as bytes. Raises ``ArchilS3Error`` (status 404, code "NoSuchKey")
            if the object does not exist — use ``head_object`` / ``object_exists`` to
            check existence without raising.

            Async: ``data = await disk.get_object.aio(key)``.
            """
            ...

        async def aio(self, /, key: str) -> bytes:
            """Read an object via the S3-compatible GetObject API and return its full
            contents as bytes. Raises ``ArchilS3Error`` (status 404, code "NoSuchKey")
            if the object does not exist — use ``head_object`` / ``object_exists`` to
            check existence without raising.

            Async: ``data = await disk.get_object.aio(key)``.
            """
            ...

    get_object: __get_object_spec

    class __head_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str) -> typing.Optional[archil._models.ObjectMetadata]:
            """Fetch an object's metadata (size, etag, content type, last-modified)
            without downloading its contents. Returns ``None`` if the object does not
            exist.
            """
            ...

        async def aio(self, /, key: str) -> typing.Optional[archil._models.ObjectMetadata]:
            """Fetch an object's metadata (size, etag, content type, last-modified)
            without downloading its contents. Returns ``None`` if the object does not
            exist.
            """
            ...

    head_object: __head_object_spec

    class __object_exists_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str) -> bool:
            ...

        async def aio(self, /, key: str) -> bool:
            ...

    object_exists: __object_exists_spec

    class __put_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, body: typing.Union[str, bytes, bytearray, memoryview], content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None, multipart_threshold: typing.Optional[int] = None, part_size: typing.Optional[int] = None, concurrency: int = 4) -> archil._models.PutObjectResult:
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
            agent sandbox). Missing parent directories inherit ``uid`` / ``gid``
            with mode ``0755``; existing directories remain unchanged. A key ending
            in ``/`` creates an explicit directory marker whose leaf uses the
            requested attributes. Defaults are ``root:root 0644`` for files and
            ``root:root 0755`` for directories.

            Async: ``await disk.put_object.aio(key, body)``.
            """
            ...

        async def aio(self, /, key: str, body: typing.Union[str, bytes, bytearray, memoryview], content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None, multipart_threshold: typing.Optional[int] = None, part_size: typing.Optional[int] = None, concurrency: int = 4) -> archil._models.PutObjectResult:
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
            agent sandbox). Missing parent directories inherit ``uid`` / ``gid``
            with mode ``0755``; existing directories remain unchanged. A key ending
            in ``/`` creates an explicit directory marker whose leaf uses the
            requested attributes. Defaults are ``root:root 0644`` for files and
            ``root:root 0755`` for directories.

            Async: ``await disk.put_object.aio(key, body)``.
            """
            ...

    put_object: __put_object_spec

    class ___put_multipart_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, data: bytes, content_type: typing.Optional[str], chunk_size: int, concurrency: int, posix_headers: typing.Optional[dict[str, str]] = None) -> archil._models.PutObjectResult:
            """Upload ``data`` through the multipart lifecycle: split into ``chunk_size``
            parts, upload them with bounded concurrency, then complete — aborting the
            upload if any part fails so nothing is left half-staged.
            """
            ...

        async def aio(self, /, key: str, data: bytes, content_type: typing.Optional[str], chunk_size: int, concurrency: int, posix_headers: typing.Optional[dict[str, str]] = None) -> archil._models.PutObjectResult:
            """Upload ``data`` through the multipart lifecycle: split into ``chunk_size``
            parts, upload them with bounded concurrency, then complete — aborting the
            upload if any part fails so nothing is left half-staged.
            """
            ...

    _put_multipart: ___put_multipart_spec

    class __append_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, body: typing.Union[str, bytes, bytearray, memoryview], content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None) -> archil._models.PutObjectResult:
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
            ``put_object``); missing parents inherit ``uid`` / ``gid`` with mode
            ``0755``. Existing files and directories are unchanged.

            Async: ``await disk.append_object.aio(key, body)``.
            """
            ...

        async def aio(self, /, key: str, body: typing.Union[str, bytes, bytearray, memoryview], content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None) -> archil._models.PutObjectResult:
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
            ``put_object``); missing parents inherit ``uid`` / ``gid`` with mode
            ``0755``. Existing files and directories are unchanged.

            Async: ``await disk.append_object.aio(key, body)``.
            """
            ...

    append_object: __append_object_spec

    class __delete_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str) -> None:
            """Delete an object via the S3-compatible DeleteObject API. Idempotent:
            deleting a key that doesn't exist resolves successfully, per S3
            semantics.
            """
            ...

        async def aio(self, /, key: str) -> None:
            """Delete an object via the S3-compatible DeleteObject API. Idempotent:
            deleting a key that doesn't exist resolves successfully, per S3
            semantics.
            """
            ...

    delete_object: __delete_object_spec

    class __list_objects_spec(typing_extensions.Protocol):
        def __call__(self, /, prefix: typing.Optional[str] = None, *, recursive: bool = False, single_page: bool = False, limit: typing.Optional[int] = None, continuation_token: typing.Optional[str] = None, start_after: typing.Optional[str] = None) -> archil._models.ListObjectsResult:
            """List objects via the S3-compatible ListObjectsV2 API. By default this
            follows continuation tokens until the listing is exhausted and returns
            every matching key. Use ``limit`` to cap the total, ``single_page`` for a
            single request, or ``list_objects_pages`` to stream pages.

            Async: ``await disk.list_objects.aio(prefix)``.
            """
            ...

        async def aio(self, /, prefix: typing.Optional[str] = None, *, recursive: bool = False, single_page: bool = False, limit: typing.Optional[int] = None, continuation_token: typing.Optional[str] = None, start_after: typing.Optional[str] = None) -> archil._models.ListObjectsResult:
            """List objects via the S3-compatible ListObjectsV2 API. By default this
            follows continuation tokens until the listing is exhausted and returns
            every matching key. Use ``limit`` to cap the total, ``single_page`` for a
            single request, or ``list_objects_pages`` to stream pages.

            Async: ``await disk.list_objects.aio(prefix)``.
            """
            ...

    list_objects: __list_objects_spec

    class __list_objects_pages_spec(typing_extensions.Protocol):
        def __call__(self, /, prefix: typing.Optional[str] = None, *, recursive: bool = False, continuation_token: typing.Optional[str] = None, start_after: typing.Optional[str] = None) -> typing.Iterator[archil._models.ListObjectsResult]:
            """Yield ListObjectsV2 pages lazily, following continuation tokens — a
            memory-friendly way to process a large listing without materializing it.
            ``limit`` / ``single_page`` don't apply here; control your own loop.

            Sync iteration: ``for page in disk.list_objects_pages(prefix): ...``.
            Async iteration: ``async for page in disk.list_objects_pages.aio(prefix): ...``.
            """
            ...

        def aio(self, /, prefix: typing.Optional[str] = None, *, recursive: bool = False, continuation_token: typing.Optional[str] = None, start_after: typing.Optional[str] = None) -> typing.AsyncIterator[archil._models.ListObjectsResult]:
            """Yield ListObjectsV2 pages lazily, following continuation tokens — a
            memory-friendly way to process a large listing without materializing it.
            ``limit`` / ``single_page`` don't apply here; control your own loop.

            Sync iteration: ``for page in disk.list_objects_pages(prefix): ...``.
            Async iteration: ``async for page in disk.list_objects_pages.aio(prefix): ...``.
            """
            ...

    list_objects_pages: __list_objects_pages_spec

    class ___list_objects_page_spec(typing_extensions.Protocol):
        def __call__(self, /, prefix: typing.Optional[str], *, recursive: bool, continuation_token: typing.Optional[str], start_after: typing.Optional[str]) -> archil._models.ListObjectsResult:
            ...

        async def aio(self, /, prefix: typing.Optional[str], *, recursive: bool, continuation_token: typing.Optional[str], start_after: typing.Optional[str]) -> archil._models.ListObjectsResult:
            ...

    _list_objects_page: ___list_objects_page_spec

    class __delete_objects_spec(typing_extensions.Protocol):
        def __call__(self, /, keys: list[str], *, quiet: bool = False) -> archil._models.DeleteObjectsResult:
            """Delete many objects in one S3-compatible DeleteObjects request. Unlike
            ``delete_object``, failures are reported per key rather than raised: the
            result's ``deleted`` lists the keys removed and ``errors`` lists the ones
            that weren't. A key that didn't exist still counts as deleted, per S3.

            The server caps a request at 1000 keys; larger inputs are split into
            1000-key batches transparently and the results merged. ``quiet`` omits
            the per-key success list server-side (``deleted`` comes back empty).

            Async: ``await disk.delete_objects.aio(keys)``.
            """
            ...

        async def aio(self, /, keys: list[str], *, quiet: bool = False) -> archil._models.DeleteObjectsResult:
            """Delete many objects in one S3-compatible DeleteObjects request. Unlike
            ``delete_object``, failures are reported per key rather than raised: the
            result's ``deleted`` lists the keys removed and ``errors`` lists the ones
            that weren't. A key that didn't exist still counts as deleted, per S3.

            The server caps a request at 1000 keys; larger inputs are split into
            1000-key batches transparently and the results merged. ``quiet`` omits
            the per-key success list server-side (``deleted`` comes back empty).

            Async: ``await disk.delete_objects.aio(keys)``.
            """
            ...

    delete_objects: __delete_objects_spec

    @property
    def multipart(self) -> Multipart:
        """The advanced, opt-in multipart-upload API. Drive the raw lifecycle
        yourself — ``create`` -> ``upload_part`` -> ``complete`` (or ``abort``),
        plus ``list_parts`` / ``list_uploads``. Most callers don't need this:
        ``put_object`` runs the whole lifecycle automatically for large bodies.
        Reach for it only when you need manual control (e.g. uploading parts from
        separate processes), and note you then own part-size, memory, and
        concurrency management.
        """
        ...


class Tokens:
    """Account-level API keys (the control-plane credentials), distinct from
    per-disk mount tokens.

    Every method is available both synchronously and asynchronously — call it
    directly to block, or use ``.aio`` for a coroutine
    (e.g. ``await archil.tokens.list.aio()``).
    """
    def __init__(self, transport: archil._http._Transport) -> None:
        ...

    class __list_spec(typing_extensions.Protocol):
        def __call__(self, /, *, limit: typing.Optional[int] = None, cursor: typing.Optional[str] = None) -> list[archil._models.ApiTokenResponse]:
            ...

        async def aio(self, /, *, limit: typing.Optional[int] = None, cursor: typing.Optional[str] = None) -> list[archil._models.ApiTokenResponse]:
            ...

    list: __list_spec

    class __create_spec(typing_extensions.Protocol):
        def __call__(self, /, *, name: str, description: typing.Optional[str] = None) -> archil._models.ApiTokenResponse:
            ...

        async def aio(self, /, *, name: str, description: typing.Optional[str] = None) -> archil._models.ApiTokenResponse:
            ...

    create: __create_spec

    class __delete_spec(typing_extensions.Protocol):
        def __call__(self, /, id: str) -> None:
            ...

        async def aio(self, /, id: str) -> None:
            ...

    delete: __delete_spec


class Workspace:
    """Use ``archil.workspace({...})`` to build one."""
    def __init__(self, client: object, mounts: dict) -> None:
        ...

    def add_disk(self, name: str, disk: object) -> Workspace:
        """Mount (or replace) a disk at ``name``; its objects are addressed as
        ``<name>/...``. Accepts a ``Disk`` or an ``ExecMountSpec`` (read-only /
        subdirectory / conditional); a bare disk-id string is rejected — fetch
        the disk first.
        """
        ...

    def remove_disk(self, name: str) -> bool:
        """Unmount the disk at ``name``. Returns whether a disk was removed.
        Refuses to remove the last disk — a workspace must always have at least
        one (the same invariant the constructor enforces), else fan-out/exec
        would have nothing to route to.
        """
        ...

    def disk_names(self) -> typing.List[str]:
        """The names of the currently-mounted disks."""
        ...

    def _unknown_disk(self, name: str) -> ValueError:
        ...

    def _route(self, key: str) -> tuple[archil._workspace._Mount, str]:
        ...

    def _covered(self, prefix: str) -> list[tuple[str, archil._workspace._Mount, str]]:
        """Mounts touched by a key prefix; an empty prefix fans out to all of them."""
        ...

    def _disk_key(self, entry: archil._workspace._Mount, rel: str) -> str:
        ...

    def _abs(self, name: str, entry: archil._workspace._Mount, disk_key: str) -> str:
        ...

    class __get_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str) -> bytes:
            ...

        async def aio(self, /, key: str) -> bytes:
            ...

    get_object: __get_object_spec

    class __put_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str, body: typing.Union[str, bytes, bytearray, memoryview], content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None) -> archil._models.PutObjectResult:
            ...

        async def aio(self, /, key: str, body: typing.Union[str, bytes, bytearray, memoryview], content_type: typing.Optional[str] = None, *, mode: typing.Optional[int] = None, uid: typing.Optional[int] = None, gid: typing.Optional[int] = None) -> archil._models.PutObjectResult:
            ...

    put_object: __put_object_spec

    class __delete_object_spec(typing_extensions.Protocol):
        def __call__(self, /, key: str) -> None:
            ...

        async def aio(self, /, key: str) -> None:
            ...

    delete_object: __delete_object_spec

    class __list_objects_spec(typing_extensions.Protocol):
        def __call__(self, /, prefix: typing.Optional[str] = None, *, recursive: bool = False) -> archil._models.ListObjectsResult:
            ...

        async def aio(self, /, prefix: typing.Optional[str] = None, *, recursive: bool = False) -> archil._models.ListObjectsResult:
            ...

    list_objects: __list_objects_spec

    class ___list_one_spec(typing_extensions.Protocol):
        def __call__(self, /, entry: archil._workspace._Mount, rel: str, recursive: bool):
            ...

        async def aio(self, /, entry: archil._workspace._Mount, rel: str, recursive: bool):
            ...

    _list_one: ___list_one_spec

    class __grep_spec(typing_extensions.Protocol):
        def __call__(self, /, *, directory: str, pattern: str, recursive: bool = False, max_duration_seconds: int = 30, concurrency: int = 50, max_results: int = 1000) -> archil._models.GrepResult:
            ...

        async def aio(self, /, *, directory: str, pattern: str, recursive: bool = False, max_duration_seconds: int = 30, concurrency: int = 50, max_results: int = 1000) -> archil._models.GrepResult:
            ...

    grep: __grep_spec

    class __exec_spec(typing_extensions.Protocol):
        def __call__(self, /, command: str) -> archil._models.ExecResult:
            ...

        async def aio(self, /, command: str) -> archil._models.ExecResult:
            ...

    exec: __exec_spec

    def agent_tools(self, *, tools: typing.Optional[typing.List[str]] = None) -> archil.agent_tools._toolset.AgentToolset:
        """Build a filesystem toolset for this workspace that drops into popular
        agent frameworks, exactly like :meth:`Disk.agent_tools` — but operations
        route to the right disk by key and ``grep`` / ``list_objects`` fan out
        across all of them.

            agent = Agent(tools=workspace.agent_tools().for_openai_agents())
        """
        ...
