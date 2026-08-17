"""Pure-Python client for Archil disks and sandboxes.

Create persistent disks and microVM sandboxes, run commands against them, and
read/write disk contents through the S3-compatible object API — all over HTTPS
with no native dependencies.

Every method is usable both synchronously and asynchronously from a single
implementation: ``disk.put_object(...)`` blocks, while ``disk.put_object.aio(...)``
returns a coroutine. This is powered by ``synchronicity`` (the same approach
Modal uses), so there is one source of truth and no duplicated sync/async logic.
"""

import threading
from typing import Optional, Sequence, Union

from ._archil import ExecMount, ExecMountSpec
from ._filesystem import FileSystem
from ._version import __version__
from ._models import (
    ApiTokenResponse,
    AuthorizedUser,
    AwsStsUser,
    AzureBlobMount,
    CompletedMultipartUpload,
    ConnectedClient,
    CreateDiskResult,
    Delegation,
    DeleteObjectsError,
    DeleteObjectsResult,
    DiskData,
    DiskMetrics,
    DiskPage,
    DiskStatus,
    DiskUser,
    ExecResult,
    ExecTiming,
    GCSMount,
    GrepMatch,
    GrepResult,
    GrepStoppedReason,
    ListObjectsResult,
    MountConfig,
    MountConfigResponse,
    MountResponse,
    MultipartUpload,
    MultipartUploadListing,
    MultipartUploadSummary,
    ObjectMetadata,
    PartInfo,
    PartListing,
    PutObjectResult,
    R2Mount,
    RootAttrs,
    S3CompatibleMount,
    S3Mount,
    S3Object,
    SandboxConnection,
    SandboxData,
    SandboxEndpoint,
    SandboxExecData,
    SandboxExecStatus,
    SandboxPlatform,
    SandboxProcessOutput,
    SandboxProcessOutputHandler,
    SandboxProcessResult,
    SandboxProcessStatus,
    SandboxProcessStream,
    SandboxPtyResult,
    SandboxStatus,
    SandboxTerminal,
    ShareUrl,
    TokenUser,
    UploadPart,
)
from ._wrapped import (
    Archil,
    Disk,
    Disks,
    Multipart,
    Sandbox,
    SandboxExec,
    SandboxProcess,
    SandboxProcesses,
    SandboxPty,
    Sandboxes,
    Tokens,
    Workspace,
)
from .agent_tools import AgentToolset
from .errors import ArchilApiError, ArchilError, ArchilS3Error, SandboxStartError

__all__ = [
    "__version__",
    "Archil",
    "Disks",
    "Disk",
    "Multipart",
    "Tokens",
    "Workspace",
    "Sandboxes",
    "Sandbox",
    "SandboxExec",
    "SandboxPty",
    "SandboxProcess",
    "SandboxProcesses",
    "FileSystem",
    "AgentToolset",
    "ExecMount",
    "ExecMountSpec",
    # errors
    "ArchilError",
    "ArchilApiError",
    "ArchilS3Error",
    "SandboxStartError",
    # input models
    "MountConfig",
    "S3Mount",
    "GCSMount",
    "R2Mount",
    "S3CompatibleMount",
    "AzureBlobMount",
    "RootAttrs",
    "DiskUser",
    "TokenUser",
    "AwsStsUser",
    "SandboxTerminal",
    # output models
    "DiskData",
    "DiskStatus",
    "MountResponse",
    "MountConfigResponse",
    "DiskMetrics",
    "ConnectedClient",
    "Delegation",
    "AuthorizedUser",
    "ApiTokenResponse",
    "ExecResult",
    "ExecTiming",
    "GrepMatch",
    "GrepResult",
    "GrepStoppedReason",
    "S3Object",
    "ObjectMetadata",
    "PutObjectResult",
    "ListObjectsResult",
    "ShareUrl",
    "UploadPart",
    "MultipartUpload",
    "CompletedMultipartUpload",
    "PartInfo",
    "PartListing",
    "MultipartUploadSummary",
    "MultipartUploadListing",
    "DeleteObjectsError",
    "DeleteObjectsResult",
    "CreateDiskResult",
    "DiskPage",
    "SandboxData",
    "SandboxExecData",
    "SandboxStatus",
    "SandboxExecStatus",
    "SandboxPlatform",
    "SandboxEndpoint",
    "SandboxConnection",
    "SandboxPtyResult",
    "SandboxProcessStatus",
    "SandboxProcessStream",
    "SandboxProcessOutput",
    "SandboxProcessOutputHandler",
    "SandboxProcessResult",
    # module-level helpers
    "configure",
    "create_disk",
    "list_disks",
    "get_disk",
    "create_sandbox",
    "list_sandboxes",
    "get_sandbox",
    "list_api_keys",
    "create_api_key",
    "delete_api_key",
    "exec",
    "workspace",
]


# Module-level Archil instance backing the top-level convenience functions.
# Defaults to env-based config (ARCHIL_API_KEY, ARCHIL_REGION); call configure()
# to pass options explicitly or to swap credentials mid-process.
_options: Optional[dict] = None
_instance: Optional[Archil] = None
# Guards the module-level singleton so concurrent helper calls don't construct
# (and orphan) two clients, and a configure() swap doesn't race a lazy init.
_lock = threading.Lock()


def configure(
    *,
    api_key: Optional[str] = None,
    region: Optional[str] = None,
    base_url: Optional[str] = None,
    s3_base_url: Optional[str] = None,
) -> None:
    global _options, _instance
    with _lock:
        # Close the previous client's HTTP connections before swapping, so
        # reconfiguring mid-process (e.g. to switch credentials) doesn't leak them.
        if _instance is not None:
            try:
                _instance.close()
            except Exception:
                pass
        _options = {
            "api_key": api_key,
            "region": region,
            "base_url": base_url,
            "s3_base_url": s3_base_url,
        }
        _instance = None


def _client() -> Archil:
    global _instance
    with _lock:
        if _instance is None:
            _instance = Archil(**(_options or {}))
        return _instance


def create_disk(
    *,
    name: str,
    mounts: Optional[Sequence[MountConfig]] = None,
    allowed_ips: Optional[list[str]] = None,
    root_attrs: Optional[RootAttrs] = None,
) -> CreateDiskResult:
    return _client().disks.create(name=name, mounts=mounts, allowed_ips=allowed_ips, root_attrs=root_attrs)


def list_disks(*, limit: Optional[int] = None, cursor: Optional[str] = None, name: Optional[str] = None) -> list[Disk]:
    return _client().disks.list(limit=limit, cursor=cursor, name=name)


def get_disk(id: str) -> Disk:
    return _client().disks.get(id)


def create_sandbox(
    *,
    name: Optional[str] = None,
    vcpu_count: Optional[int] = None,
    mem_size_mib: Optional[int] = None,
    base_image: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
    max_ttl_seconds: Optional[int] = None,
    max_concurrent_execs: Optional[int] = None,
    wait: bool = True,
) -> Sandbox:
    return _client().sandboxes.create(
        name=name,
        vcpu_count=vcpu_count,
        mem_size_mib=mem_size_mib,
        base_image=base_image,
        env=env,
        max_ttl_seconds=max_ttl_seconds,
        max_concurrent_execs=max_concurrent_execs,
        wait=wait,
    )


def list_sandboxes(*, disk: Optional[Union[Disk, str]] = None) -> list[Sandbox]:
    return _client().sandboxes.list(disk=disk)


def get_sandbox(id: str) -> Sandbox:
    return _client().sandboxes.get(id)


def list_api_keys(*, limit: Optional[int] = None, cursor: Optional[str] = None) -> list[ApiTokenResponse]:
    return _client().tokens.list(limit=limit, cursor=cursor)


def create_api_key(*, name: str, description: Optional[str] = None) -> ApiTokenResponse:
    return _client().tokens.create(name=name, description=description)


def delete_api_key(id: str) -> None:
    return _client().tokens.delete(id)


def exec(*, disks: dict, command: str) -> ExecResult:
    return _client().exec(disks=disks, command=command)


def workspace(mounts: dict) -> Workspace:
    """Build a :class:`Workspace` spanning several disks, using the module-level
    client. See :meth:`Archil.workspace`."""
    return _client().workspace(mounts)
