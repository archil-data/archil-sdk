from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Optional, Union

# ---------------------------------------------------------------------------
# Output models — parsed from the control-plane JSON (camelCase) into snake_case
# Python dataclasses. Each carries a from_json classmethod; unknown fields are
# ignored so a server that adds fields doesn't break older clients.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AuthorizedUser:
    type: Optional[str] = None
    principal: Optional[str] = None
    nickname: Optional[str] = None
    token_suffix: Optional[str] = None
    token: Optional[str] = None
    identifier: Optional[str] = None
    created_at: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "AuthorizedUser":
        return cls(
            type=d.get("type"),
            principal=d.get("principal"),
            nickname=d.get("nickname"),
            token_suffix=d.get("tokenSuffix"),
            token=d.get("token"),
            identifier=d.get("identifier"),
            created_at=d.get("createdAt"),
        )


@dataclass(frozen=True)
class MountConfigResponse:
    bucket_name: Optional[str] = None
    bucket_endpoint: Optional[str] = None
    bucket_prefix: Optional[str] = None
    session_id: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "MountConfigResponse":
        return cls(
            bucket_name=d.get("bucketName"),
            bucket_endpoint=d.get("bucketEndpoint"),
            bucket_prefix=d.get("bucketPrefix"),
            session_id=d.get("sessionId"),
        )


@dataclass(frozen=True)
class MountResponse:
    id: Optional[str] = None
    type: Optional[str] = None
    path: Optional[str] = None
    name: Optional[str] = None
    access_mode: Optional[str] = None
    config: Optional[MountConfigResponse] = None
    connection_status: Optional[str] = None
    auth_error: Optional[str] = None
    authorization_type: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "MountResponse":
        config = d.get("config")
        return cls(
            id=d.get("id"),
            type=d.get("type"),
            path=d.get("path"),
            name=d.get("name"),
            access_mode=d.get("accessMode"),
            config=MountConfigResponse.from_json(config) if config is not None else None,
            connection_status=d.get("connectionStatus"),
            auth_error=d.get("authError"),
            authorization_type=d.get("authorizationType"),
        )


@dataclass(frozen=True)
class DiskMetrics:
    data_transfer: Optional[str] = None
    requests: Optional[str] = None
    avg_response_time: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "DiskMetrics":
        return cls(
            data_transfer=d.get("dataTransfer"),
            requests=d.get("requests"),
            avg_response_time=d.get("avgResponseTime"),
        )


@dataclass(frozen=True)
class ConnectedClient:
    id: Optional[str] = None
    ip_address: Optional[str] = None
    connected_at: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "ConnectedClient":
        return cls(
            id=d.get("id"),
            ip_address=d.get("ipAddress"),
            connected_at=d.get("connectedAt"),
        )


@dataclass(frozen=True)
class Delegation:
    client_id: str
    inode_id: int
    is_pending: bool
    is_orphaned: bool
    path: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "Delegation":
        return cls(
            client_id=d["clientId"],
            inode_id=d["inodeId"],
            path=d.get("path"),
            is_pending=d["isPending"],
            is_orphaned=d["isOrphaned"],
        )


DiskStatus = Literal["available", "creating", "deleting", "deleted", "failed"]


@dataclass(frozen=True)
class DiskData:
    """The full disk record returned by the control plane. Exposed field-by-field
    as read-only properties on a ``Disk``."""

    id: str
    name: str
    organization: str
    status: "DiskStatus"
    provider: str
    region: str
    created_at: str
    fs_handler_status: Optional[str] = None
    last_accessed: Optional[str] = None
    data_size: Optional[int] = None
    monthly_usage: Optional[str] = None
    mounts: Optional[list[MountResponse]] = None
    metrics: Optional[DiskMetrics] = None
    connected_clients: Optional[list[ConnectedClient]] = None
    authorized_users: Optional[list[AuthorizedUser]] = None
    allowed_ips: Optional[list[str]] = None
    capabilities: Optional[list[str]] = None

    @classmethod
    def from_json(cls, d: dict) -> "DiskData":
        mounts = d.get("mounts")
        metrics = d.get("metrics")
        clients = d.get("connectedClients")
        users = d.get("authorizedUsers")
        return cls(
            id=d["id"],
            name=d["name"],
            organization=d["organization"],
            status=d["status"],
            provider=d["provider"],
            region=d["region"],
            created_at=d["createdAt"],
            fs_handler_status=d.get("fsHandlerStatus"),
            last_accessed=d.get("lastAccessed"),
            data_size=d.get("dataSize"),
            monthly_usage=d.get("monthlyUsage"),
            # `is not None` (not truthiness) so a present-but-empty array `[]` is
            # preserved as `[]`, distinct from a missing/null field (-> None),
            # matching the TS SDK and the allowed_ips field.
            mounts=[MountResponse.from_json(m) for m in mounts] if mounts is not None else None,
            metrics=DiskMetrics.from_json(metrics) if metrics is not None else None,
            connected_clients=(
                [ConnectedClient.from_json(c) for c in clients] if clients is not None else None
            ),
            authorized_users=(
                [AuthorizedUser.from_json(u) for u in users] if users is not None else None
            ),
            allowed_ips=d.get("allowedIps"),
            capabilities=d.get("capabilities"),
        )


@dataclass(frozen=True)
class ExecTiming:
    total_ms: int
    queue_ms: int
    execute_ms: int

    @classmethod
    def from_json(cls, d: dict) -> "ExecTiming":
        return cls(
            total_ms=d["totalMs"],
            queue_ms=d["queueMs"],
            execute_ms=d["executeMs"],
        )


@dataclass(frozen=True)
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str
    timing: ExecTiming

    @classmethod
    def from_json(cls, d: dict) -> "ExecResult":
        return cls(
            exit_code=d["exitCode"],
            stdout=d["stdout"],
            stderr=d["stderr"],
            timing=ExecTiming.from_json(d["timing"]),
        )


GrepStoppedReason = Literal["completed", "incomplete", "max_results", "deadline", "list_failed"]


@dataclass(frozen=True)
class GrepMatch:
    file: str
    line: int
    text: str

    @classmethod
    def from_json(cls, d: dict) -> "GrepMatch":
        return cls(file=d["file"], line=d["line"], text=d["text"])


@dataclass(frozen=True)
class GrepResult:
    matches: list[GrepMatch]
    stopped_reason: str
    files_scanned: int
    containers_dispatched: int
    compute_seconds_used: float
    duration_ms: int
    listing_ms: int
    grep_ms: int

    @classmethod
    def from_json(cls, d: dict) -> "GrepResult":
        return cls(
            matches=[GrepMatch.from_json(m) for m in (d.get("matches") or [])],
            stopped_reason=d["stoppedReason"],
            files_scanned=d["filesScanned"],
            containers_dispatched=d["containersDispatched"],
            compute_seconds_used=d["computeSecondsUsed"],
            duration_ms=d["durationMs"],
            listing_ms=d["listingMs"],
            grep_ms=d["grepMs"],
        )


@dataclass(frozen=True)
class ApiTokenResponse:
    id: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    token_suffix: Optional[str] = None
    created_at: Optional[str] = None
    last_used_at: Optional[str] = None
    # Only present in the create response — the full token, shown exactly once.
    token: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "ApiTokenResponse":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            description=d.get("description"),
            token_suffix=d.get("tokenSuffix"),
            created_at=d.get("createdAt"),
            last_used_at=d.get("lastUsedAt"),
            token=d.get("token"),
        )


@dataclass(frozen=True)
class ShareUrl:
    url: str
    expires_in: int

    @classmethod
    def from_json(cls, d: dict) -> "ShareUrl":
        return cls(url=d["url"], expires_in=d["expiresIn"])


@dataclass(frozen=True)
class S3Object:
    key: str
    size: int
    etag: Optional[str] = None
    last_modified: Optional[datetime] = None


@dataclass(frozen=True)
class ObjectMetadata:
    size: int
    etag: Optional[str] = None
    content_type: Optional[str] = None
    last_modified: Optional[datetime] = None


@dataclass(frozen=True)
class PutObjectResult:
    etag: Optional[str] = None


@dataclass(frozen=True)
class ListObjectsResult:
    objects: list[S3Object]
    common_prefixes: list[str]
    is_truncated: bool
    key_count: int
    next_continuation_token: Optional[str] = None
    prefix: Optional[str] = None


@dataclass(frozen=True)
class UploadPart:
    """One uploaded part, returned by ``upload_part`` and passed back to
    ``complete_multipart_upload``."""

    part_number: int
    etag: str


@dataclass(frozen=True)
class MultipartUpload:
    """Handle to an in-progress multipart upload, from ``create_multipart_upload``."""

    upload_id: str
    key: str
    bucket: str


@dataclass(frozen=True)
class CompletedMultipartUpload:
    """The assembled object, from ``complete_multipart_upload`` / ``upload_object``."""

    etag: Optional[str] = None
    location: Optional[str] = None
    bucket: Optional[str] = None
    key: Optional[str] = None


@dataclass(frozen=True)
class PartInfo:
    """One part in a ``list_parts`` listing."""

    part_number: int
    size: int
    etag: Optional[str] = None
    last_modified: Optional[datetime] = None


@dataclass(frozen=True)
class PartListing:
    parts: list[PartInfo]
    is_truncated: bool
    part_number_marker: int
    max_parts: int
    bucket: Optional[str] = None
    key: Optional[str] = None
    upload_id: Optional[str] = None
    next_part_number_marker: Optional[int] = None


@dataclass(frozen=True)
class MultipartUploadSummary:
    """One in-progress upload in a ``list_multipart_uploads`` listing."""

    key: str
    upload_id: str
    initiated: Optional[datetime] = None


@dataclass(frozen=True)
class MultipartUploadListing:
    uploads: list[MultipartUploadSummary]
    common_prefixes: list[str]
    is_truncated: bool
    bucket: Optional[str] = None
    key_marker: Optional[str] = None
    upload_id_marker: Optional[str] = None
    next_key_marker: Optional[str] = None
    next_upload_id_marker: Optional[str] = None
    prefix: Optional[str] = None
    delimiter: Optional[str] = None
    max_uploads: Optional[int] = None


@dataclass(frozen=True)
class DeleteObjectsError:
    """A single per-key failure within a ``delete_objects`` batch."""

    key: str
    code: Optional[str] = None
    message: Optional[str] = None


@dataclass(frozen=True)
class DeleteObjectsResult:
    deleted: list[str]
    errors: list[DeleteObjectsError]


# ---------------------------------------------------------------------------
# Input models — mounts and disk users. Each carries a to_json that emits the
# camelCase shape the control plane expects, including the ``type`` discriminator.
# ---------------------------------------------------------------------------


def _drop_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


@dataclass
class S3Mount:
    bucket_name: str
    access_key_id: Optional[str] = None
    secret_access_key: Optional[str] = None
    session_token: Optional[str] = None
    bucket_prefix: Optional[str] = None

    def to_json(self) -> dict:
        return _drop_none(
            {
                "type": "s3",
                "bucketName": self.bucket_name,
                "accessKeyId": self.access_key_id,
                "secretAccessKey": self.secret_access_key,
                "sessionToken": self.session_token,
                "bucketPrefix": self.bucket_prefix,
            }
        )


@dataclass
class GCSMount:
    bucket_name: str
    access_key_id: str
    secret_access_key: str
    bucket_prefix: Optional[str] = None

    def to_json(self) -> dict:
        return _drop_none(
            {
                "type": "gcs",
                "bucketName": self.bucket_name,
                "accessKeyId": self.access_key_id,
                "secretAccessKey": self.secret_access_key,
                "bucketPrefix": self.bucket_prefix,
            }
        )


@dataclass
class R2Mount:
    bucket_name: str
    bucket_endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket_prefix: Optional[str] = None

    def to_json(self) -> dict:
        return _drop_none(
            {
                "type": "r2",
                "bucketName": self.bucket_name,
                "bucketEndpoint": self.bucket_endpoint,
                "accessKeyId": self.access_key_id,
                "secretAccessKey": self.secret_access_key,
                "bucketPrefix": self.bucket_prefix,
            }
        )


@dataclass
class S3CompatibleMount:
    bucket_name: str
    bucket_endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket_prefix: Optional[str] = None

    def to_json(self) -> dict:
        return _drop_none(
            {
                "type": "s3-compatible",
                "bucketName": self.bucket_name,
                "bucketEndpoint": self.bucket_endpoint,
                "accessKeyId": self.access_key_id,
                "secretAccessKey": self.secret_access_key,
                "bucketPrefix": self.bucket_prefix,
            }
        )


@dataclass
class AzureBlobMount:
    container_name: str
    tenant_id: str
    client_id: str
    client_secret: str
    endpoint: Optional[str] = None
    storage_account_name: Optional[str] = None
    bucket_prefix: Optional[str] = None

    def to_json(self) -> dict:
        return _drop_none(
            {
                "type": "azure-blob",
                "containerName": self.container_name,
                "endpoint": self.endpoint,
                "storageAccountName": self.storage_account_name,
                "tenantId": self.tenant_id,
                "clientId": self.client_id,
                "clientSecret": self.client_secret,
                "bucketPrefix": self.bucket_prefix,
            }
        )


MountConfig = Union[S3Mount, GCSMount, R2Mount, S3CompatibleMount, AzureBlobMount]


@dataclass
class TokenUser:
    nickname: str
    principal: Optional[str] = None
    token_suffix: Optional[str] = None

    def to_json(self) -> dict:
        return _drop_none(
            {
                "type": "token",
                "nickname": self.nickname,
                "principal": self.principal,
                "tokenSuffix": self.token_suffix,
            }
        )


@dataclass
class AwsStsUser:
    principal: str

    def to_json(self) -> dict:
        return {"type": "awssts", "principal": self.principal}


DiskUser = Union[TokenUser, AwsStsUser]


@dataclass(frozen=True)
class CreateDiskResult:
    disk: Any  # a Disk (wrapped); typed as Any to avoid an import cycle.
    token: Optional[str]
    token_identifier: Optional[str]
    authorized_users: list[AuthorizedUser] = field(default_factory=list)


@dataclass(frozen=True)
class DiskPage:
    """One page of a disk listing. ``next_cursor`` is set when more disks
    remain; pass it back as ``cursor`` to resume. Absent on the last page."""

    disks: list[Any]  # Disks (wrapped); typed as Any to avoid an import cycle.
    next_cursor: Optional[str] = None
