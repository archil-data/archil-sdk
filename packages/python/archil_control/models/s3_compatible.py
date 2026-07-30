from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.s3_compatible_type import S3CompatibleType
from ..types import UNSET, Unset

T = TypeVar("T", bound="S3Compatible")


@_attrs_define
class S3Compatible:
    """Mount configuration for S3-compatible storage (MinIO, Backblaze B2, etc.)

    Attributes:
        type_ (S3CompatibleType): Mount type identifier
        bucket_name (str): Bucket name Example: my-bucket.
        bucket_endpoint (str): S3-compatible endpoint URL Example: https://s3.us-west-001.backblazeb2.com.
        access_key_id (str): Access key ID
        secret_access_key (str): Secret access key
        bucket_prefix (Union[Unset, str]): Prefix within the bucket (optional) Example: data/.
        bucket_region (Union[Unset, str]): Bucket region Example: auto.
    """

    type_: S3CompatibleType
    bucket_name: str
    bucket_endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket_prefix: Union[Unset, str] = UNSET
    bucket_region: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        bucket_name = self.bucket_name

        bucket_endpoint = self.bucket_endpoint

        access_key_id = self.access_key_id

        secret_access_key = self.secret_access_key

        bucket_prefix = self.bucket_prefix

        bucket_region = self.bucket_region

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "bucketName": bucket_name,
                "bucketEndpoint": bucket_endpoint,
                "accessKeyId": access_key_id,
                "secretAccessKey": secret_access_key,
            }
        )
        if bucket_prefix is not UNSET:
            field_dict["bucketPrefix"] = bucket_prefix
        if bucket_region is not UNSET:
            field_dict["bucketRegion"] = bucket_region

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = S3CompatibleType(d.pop("type"))

        bucket_name = d.pop("bucketName")

        bucket_endpoint = d.pop("bucketEndpoint")

        access_key_id = d.pop("accessKeyId")

        secret_access_key = d.pop("secretAccessKey")

        bucket_prefix = d.pop("bucketPrefix", UNSET)

        bucket_region = d.pop("bucketRegion", UNSET)

        s3_compatible = cls(
            type_=type_,
            bucket_name=bucket_name,
            bucket_endpoint=bucket_endpoint,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            bucket_prefix=bucket_prefix,
            bucket_region=bucket_region,
        )

        s3_compatible.additional_properties = d
        return s3_compatible

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
