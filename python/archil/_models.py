from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional, Union

from archil_openapi.models.authorized_user import AuthorizedUser
from archil_openapi.models.aws_sts_user import AwsStsUser as OpenApiAwsStsUser
from archil_openapi.models.aws_sts_user_type import AwsStsUserType
from archil_openapi.models.azure_blob_storage import AzureBlobStorage
from archil_openapi.models.azure_blob_storage_type import AzureBlobStorageType
from archil_openapi.models.cloudflare_r2 import CloudflareR2
from archil_openapi.models.cloudflare_r2_type import CloudflareR2Type
from archil_openapi.models.google_cloud_storage import GoogleCloudStorage
from archil_openapi.models.google_cloud_storage_type import GoogleCloudStorageType
from archil_openapi.models.s3 import S3
from archil_openapi.models.s3_compatible import S3Compatible
from archil_openapi.models.s3_compatible_type import S3CompatibleType
from archil_openapi.models.s3_type import S3Type
from archil_openapi.models.token_user import TokenUser as OpenApiTokenUser
from archil_openapi.models.token_user_type import TokenUserType
from archil_openapi.types import UNSET


def _optional(value: Any) -> Any:
    return UNSET if value is None else value


# These thin subclasses keep the SDK's existing ergonomic constructors while
# delegating the fields and wire serialization to archil-openapi.
class S3Mount(S3):
    def __init__(
        self,
        bucket_name: str,
        access_key_id: Optional[str] = None,
        secret_access_key: Optional[str] = None,
        session_token: Optional[str] = None,
        bucket_prefix: Optional[str] = None,
        bucket_region: Optional[str] = None,
    ) -> None:
        super().__init__(
            type_=S3Type.S3,
            bucket_name=bucket_name,
            access_key_id=_optional(access_key_id),
            secret_access_key=_optional(secret_access_key),
            session_token=_optional(session_token),
            bucket_prefix=_optional(bucket_prefix),
            bucket_region=_optional(bucket_region),
        )


class GCSMount(GoogleCloudStorage):
    def __init__(
        self,
        bucket_name: str,
        access_key_id: str,
        secret_access_key: str,
        bucket_prefix: Optional[str] = None,
        bucket_region: Optional[str] = None,
    ) -> None:
        super().__init__(
            type_=GoogleCloudStorageType.GCS,
            bucket_name=bucket_name,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            bucket_prefix=_optional(bucket_prefix),
            bucket_region=_optional(bucket_region),
        )


class R2Mount(CloudflareR2):
    def __init__(
        self,
        bucket_name: str,
        bucket_endpoint: str,
        access_key_id: str,
        secret_access_key: str,
        bucket_prefix: Optional[str] = None,
        bucket_region: Optional[str] = None,
    ) -> None:
        super().__init__(
            type_=CloudflareR2Type.R2,
            bucket_name=bucket_name,
            bucket_endpoint=bucket_endpoint,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            bucket_prefix=_optional(bucket_prefix),
            bucket_region=_optional(bucket_region),
        )


class S3CompatibleMount(S3Compatible):
    def __init__(
        self,
        bucket_name: str,
        bucket_endpoint: str,
        access_key_id: str,
        secret_access_key: str,
        bucket_prefix: Optional[str] = None,
        bucket_region: Optional[str] = None,
    ) -> None:
        super().__init__(
            type_=S3CompatibleType.S3_COMPATIBLE,
            bucket_name=bucket_name,
            bucket_endpoint=bucket_endpoint,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            bucket_prefix=_optional(bucket_prefix),
            bucket_region=_optional(bucket_region),
        )


class AzureBlobMount(AzureBlobStorage):
    def __init__(
        self,
        container_name: str,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        endpoint: Optional[str] = None,
        storage_account_name: Optional[str] = None,
        bucket_prefix: Optional[str] = None,
    ) -> None:
        super().__init__(
            type_=AzureBlobStorageType.AZURE_BLOB,
            container_name=container_name,
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret,
            endpoint=_optional(endpoint),
            storage_account_name=_optional(storage_account_name),
            bucket_prefix=_optional(bucket_prefix),
        )


MountConfig = Union[S3Mount, GCSMount, R2Mount, S3CompatibleMount, AzureBlobMount]


class TokenUser(OpenApiTokenUser):
    def __init__(
        self,
        nickname: str,
        principal: Optional[str] = None,
        token_suffix: Optional[str] = None,
        ttl: Optional[str] = None,
        expires_at: Optional[datetime] = None,
        one_use: Optional[bool] = None,
        read_only: Optional[bool] = None,
    ) -> None:
        super().__init__(
            type_=TokenUserType.TOKEN,
            nickname=nickname,
            principal=_optional(principal),
            token_suffix=_optional(token_suffix),
            ttl=_optional(ttl),
            expires_at=_optional(expires_at),
            one_use=_optional(one_use),
            read_only=_optional(read_only),
        )


class AwsStsUser(OpenApiAwsStsUser):
    def __init__(
        self,
        principal: str,
        ttl: Optional[str] = None,
        expires_at: Optional[datetime] = None,
        one_use: Optional[bool] = None,
        read_only: Optional[bool] = None,
    ) -> None:
        super().__init__(
            type_=AwsStsUserType.AWSSTS,
            principal=principal,
            ttl=_optional(ttl),
            expires_at=_optional(expires_at),
            one_use=_optional(one_use),
            read_only=_optional(read_only),
        )


DiskUser = Union[TokenUser, AwsStsUser]


# S3 gateway models are SDK-specific and are not part of the control-plane
# OpenAPI schema.
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
