from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.cloudflare_r2_type import CloudflareR2Type
from ..types import UNSET, Unset

T = TypeVar("T", bound="CloudflareR2")


@_attrs_define
class CloudflareR2:
    """Mount configuration for Cloudflare R2 buckets

    Attributes:
        type_ (CloudflareR2Type): Mount type identifier
        bucket_name (str): R2 bucket name Example: my-r2-bucket.
        bucket_endpoint (str): R2 endpoint URL Example: https://accountid.r2.cloudflarestorage.com.
        access_key_id (str): R2 access key ID
        secret_access_key (str): R2 secret access key
        bucket_prefix (Union[Unset, str]): Prefix within the bucket (optional) Example: data/.
    """

    type_: CloudflareR2Type
    bucket_name: str
    bucket_endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket_prefix: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        bucket_name = self.bucket_name

        bucket_endpoint = self.bucket_endpoint

        access_key_id = self.access_key_id

        secret_access_key = self.secret_access_key

        bucket_prefix = self.bucket_prefix

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

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = CloudflareR2Type(d.pop("type"))

        bucket_name = d.pop("bucketName")

        bucket_endpoint = d.pop("bucketEndpoint")

        access_key_id = d.pop("accessKeyId")

        secret_access_key = d.pop("secretAccessKey")

        bucket_prefix = d.pop("bucketPrefix", UNSET)

        cloudflare_r2 = cls(
            type_=type_,
            bucket_name=bucket_name,
            bucket_endpoint=bucket_endpoint,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            bucket_prefix=bucket_prefix,
        )

        cloudflare_r2.additional_properties = d
        return cloudflare_r2

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
