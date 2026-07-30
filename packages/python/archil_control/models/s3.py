from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.s3_type import S3Type
from ..types import UNSET, Unset

T = TypeVar("T", bound="S3")


@_attrs_define
class S3:
    """Mount configuration for Amazon S3 buckets

    Attributes:
        type_ (S3Type): Mount type identifier
        bucket_name (str): S3 bucket name Example: my-bucket.
        access_key_id (Union[Unset, str]): AWS access key ID (optional for public buckets or IAM role auth)
        secret_access_key (Union[Unset, str]): AWS secret access key
        session_token (Union[Unset, str]): Session token for temporary credentials
        bucket_prefix (Union[Unset, str]): Prefix within the bucket Example: data/.
        bucket_region (Union[Unset, str]): Bucket region Example: us-east-1.
    """

    type_: S3Type
    bucket_name: str
    access_key_id: Union[Unset, str] = UNSET
    secret_access_key: Union[Unset, str] = UNSET
    session_token: Union[Unset, str] = UNSET
    bucket_prefix: Union[Unset, str] = UNSET
    bucket_region: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        bucket_name = self.bucket_name

        access_key_id = self.access_key_id

        secret_access_key = self.secret_access_key

        session_token = self.session_token

        bucket_prefix = self.bucket_prefix

        bucket_region = self.bucket_region

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "bucketName": bucket_name,
            }
        )
        if access_key_id is not UNSET:
            field_dict["accessKeyId"] = access_key_id
        if secret_access_key is not UNSET:
            field_dict["secretAccessKey"] = secret_access_key
        if session_token is not UNSET:
            field_dict["sessionToken"] = session_token
        if bucket_prefix is not UNSET:
            field_dict["bucketPrefix"] = bucket_prefix
        if bucket_region is not UNSET:
            field_dict["bucketRegion"] = bucket_region

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = S3Type(d.pop("type"))

        bucket_name = d.pop("bucketName")

        access_key_id = d.pop("accessKeyId", UNSET)

        secret_access_key = d.pop("secretAccessKey", UNSET)

        session_token = d.pop("sessionToken", UNSET)

        bucket_prefix = d.pop("bucketPrefix", UNSET)

        bucket_region = d.pop("bucketRegion", UNSET)

        s3 = cls(
            type_=type_,
            bucket_name=bucket_name,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            session_token=session_token,
            bucket_prefix=bucket_prefix,
            bucket_region=bucket_region,
        )

        s3.additional_properties = d
        return s3

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
