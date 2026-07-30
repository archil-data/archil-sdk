"""Pure-Python client for Archil disks.

Create disks, list and inspect them, manage who can mount them, run commands
against them, and read/write their contents through the S3-compatible object
API — all over HTTPS with no native dependencies.

Every method is usable both synchronously and asynchronously from a single
implementation: ``disk.put_object(...)`` blocks, while ``disk.put_object.aio(...)``
returns a coroutine. This is powered by ``synchronicity`` (the same approach
Modal uses), so there is one source of truth and no duplicated sync/async logic.
"""

import threading
from typing import Optional, Sequence

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
    S3CompatibleMount,
    S3Mount,
    S3Object,
    ShareUrl,
    TokenUser,
    UploadPart,
)
from ._wrapped import Archil, Disk, Disks, Multipart, Tokens, Workspace
from .agent_tools import AgentToolset
from .errors import ArchilApiError, ArchilError, ArchilS3Error
from .openapi import AuthenticatedClient, Client

__all__ = [
    "__version__",
    "Archil",
    "Client",
    "AuthenticatedClient",
    "Disks",
    "Disk",
    "Multipart",
    "Tokens",
    "Workspace",
    "FileSystem",
    "AgentToolset",
    "ExecMount",
    "ExecMountSpec",
    # errors
    "ArchilError",
    "ArchilApiError",
    "ArchilS3Error",
    # input models
    "MountConfig",
    "S3Mount",
    "GCSMount",
    "R2Mount",
    "S3CompatibleMount",
    "AzureBlobMount",
    "DiskUser",
    "TokenUser",
    "AwsStsUser",
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
    # module-level helpers
    "configure",
    "create_disk",
    "list_disks",
    "get_disk",
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
) -> CreateDiskResult:
    return _client().disks.create(name=name, mounts=mounts, allowed_ips=allowed_ips)


def list_disks(
    *, limit: Optional[int] = None, cursor: Optional[str] = None, name: Optional[str] = None
) -> list[Disk]:
    return _client().disks.list(limit=limit, cursor=cursor, name=name)


def get_disk(id: str) -> Disk:
    return _client().disks.get(id)


def list_api_keys(
    *, limit: Optional[int] = None, cursor: Optional[str] = None
) -> list[ApiTokenResponse]:
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
