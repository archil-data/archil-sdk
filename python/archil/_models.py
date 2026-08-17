from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Literal, Optional, Union

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
    active_data_bytes: Optional[int] = None
    total_data_bytes: Optional[int] = None
    monthly_usage: Optional[str] = None
    mounts: Optional[list[MountResponse]] = None
    metrics: Optional[DiskMetrics] = None
    connected_clients: Optional[list[ConnectedClient]] = None
    authorized_users: Optional[list[AuthorizedUser]] = None
    allowed_ips: Optional[list[str]] = None
    capabilities: Optional[list[str]] = None
    root_attrs: Optional["RootAttrs"] = None

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
            active_data_bytes=d.get("activeDataBytes"),
            total_data_bytes=d.get("totalDataBytes"),
            monthly_usage=d.get("monthlyUsage"),
            # `is not None` (not truthiness) so a present-but-empty array `[]` is
            # preserved as `[]`, distinct from a missing/null field (-> None),
            # matching the TS SDK and the allowed_ips field.
            mounts=[MountResponse.from_json(m) for m in mounts] if mounts is not None else None,
            metrics=DiskMetrics.from_json(metrics) if metrics is not None else None,
            connected_clients=([ConnectedClient.from_json(c) for c in clients] if clients is not None else None),
            authorized_users=([AuthorizedUser.from_json(u) for u in users] if users is not None else None),
            allowed_ips=d.get("allowedIps"),
            capabilities=d.get("capabilities"),
            root_attrs=(
                RootAttrs(uid=ra.get("uid"), gid=ra.get("gid"), mode=ra.get("mode"))
                if (ra := d.get("rootAttrs")) is not None
                else None
            ),
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


SandboxStatus = Literal[
    "pending",
    "running",
    "pausing",
    "paused",
    "stopping",
    "stopped",
    "exited",
    "failed",
    "deleting",
    "deleted",
]
SandboxExecStatus = Literal["running", "completed", "failed", "cancelled", "timed_out"]
SandboxProcessStatus = Literal["running", "completed", "failed", "cancelled", "timed_out"]
SandboxProcessStream = Literal["stdout", "stderr"]
SandboxPlatform = Literal["arm64", "amd64"]


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass(frozen=True)
class SandboxEndpoint:
    port: int
    hostname: str

    @classmethod
    def from_json(cls, d: dict) -> "SandboxEndpoint":
        return cls(port=d["port"], hostname=d["hostname"])


@dataclass(frozen=True)
class SandboxData:
    id: str
    name: str
    status: SandboxStatus
    vcpu_count: int
    mem_size_mib: int
    max_ttl_seconds: int
    max_concurrent_execs: int
    base_image: str
    created_at: datetime
    last_active_at: datetime
    platform: Optional[SandboxPlatform] = None
    endpoints: list[SandboxEndpoint] = field(default_factory=list)
    running_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    exit_reason: Optional[str] = None

    @classmethod
    def from_json(cls, d: dict) -> "SandboxData":
        return cls(
            id=d["sandbox_id"],
            name=d["name"],
            status=d["status"],
            vcpu_count=d["vcpu_count"],
            mem_size_mib=d["mem_size_mib"],
            max_ttl_seconds=d["max_ttl_seconds"],
            max_concurrent_execs=d["max_concurrent_execs"],
            base_image=d["base_image"],
            platform=d.get("platform"),
            endpoints=[SandboxEndpoint.from_json(endpoint) for endpoint in d.get("endpoints") or []],
            created_at=_parse_datetime(d["created_at"]),
            running_at=_parse_datetime(d["running_at"]) if d.get("running_at") else None,
            finished_at=_parse_datetime(d["finished_at"]) if d.get("finished_at") else None,
            last_active_at=_parse_datetime(d["last_active_at"]),
            expires_at=_parse_datetime(d["expires_at"]) if d.get("expires_at") else None,
            exit_reason=d.get("exit_reason"),
        )


@dataclass(frozen=True)
class SandboxExecData:
    sandbox_id: str
    id: str
    command: str
    status: SandboxExecStatus
    started_at: datetime
    exit_code: Optional[int] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    exit_reason: Optional[str] = None
    execute_time_ms: Optional[int] = None
    finished_at: Optional[datetime] = None

    @classmethod
    def from_json(cls, d: dict) -> "SandboxExecData":
        return cls(
            sandbox_id=d["sandbox_id"],
            id=d["exec_id"],
            command=d["command"],
            status=d["status"],
            exit_code=d.get("exit_code"),
            stdout=d.get("stdout"),
            stderr=d.get("stderr"),
            exit_reason=d.get("exit_reason"),
            execute_time_ms=d.get("execute_time_ms"),
            started_at=_parse_datetime(d["started_at"]),
            finished_at=_parse_datetime(d["finished_at"]) if d.get("finished_at") else None,
        )


@dataclass(frozen=True)
class SandboxConnection:
    url: str
    expires_at: datetime

    @classmethod
    def from_json(cls, d: dict) -> "SandboxConnection":
        return cls(url=d["url"], expires_at=_parse_datetime(d["expires_at"]))


@dataclass(frozen=True)
class SandboxPtyResult:
    exit_code: Optional[int] = None


@dataclass(frozen=True)
class SandboxTerminal:
    cols: int = 80
    rows: int = 24


@dataclass(frozen=True)
class SandboxProcessOutput:
    stream: SandboxProcessStream
    offset: int
    data: bytes


SandboxProcessOutputHandler = Callable[[SandboxProcessOutput], None]


@dataclass(frozen=True)
class SandboxProcessResult:
    status: Literal["completed", "failed", "cancelled", "timed_out"]
    stdout: str
    stderr: str
    exit_code: Optional[int] = None
    exit_reason: Optional[str] = None


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


@dataclass
class RootAttrs:
    """POSIX attributes for the disk's root directory, applied at creation.

    Lets an unprivileged process own the mount root without a post-mount
    ``chown``. Omitted fields default server-side to uid 0, gid 0, mode
    ``0o755``. ``mode`` takes permission bits only (setuid/setgid/sticky are
    rejected). Can only be set at creation; a later ``chown``/``chmod``
    through a mount changes the live attributes as usual."""

    uid: Optional[int] = None
    gid: Optional[int] = None
    mode: Optional[int] = None

    def to_json(self) -> dict:
        if self.mode is not None and not 0 <= self.mode <= 0o777:
            raise ValueError(
                f"mode must be permission bits only (0..0o777), got {self.mode}"
                " — note mode is octal: pass 0o750, not 750"
            )
        for field_name, value in (("uid", self.uid), ("gid", self.gid)):
            # 2**32 - 1 is the POSIX chown(-1) "unchanged" sentinel.
            if value is not None and not 0 <= value < 2**32 - 1:
                raise ValueError(f"{field_name} must be in 0..4294967294, got {value}")
        return _drop_none({"uid": self.uid, "gid": self.gid, "mode": self.mode})


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
