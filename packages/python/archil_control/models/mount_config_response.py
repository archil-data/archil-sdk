from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="MountConfigResponse")


@_attrs_define
class MountConfigResponse:
    """Mount configuration details (secrets omitted)

    Attributes:
        bucket_name (Union[Unset, str]): Bucket name
        bucket_endpoint (Union[Unset, str]): Storage endpoint URL
        bucket_prefix (Union[Unset, str]): Prefix within the bucket
        bucket_region (Union[Unset, str]): Bucket region
        session_id (Union[Unset, str]): Session identifier for IAM-authorized mounts
    """

    bucket_name: Union[Unset, str] = UNSET
    bucket_endpoint: Union[Unset, str] = UNSET
    bucket_prefix: Union[Unset, str] = UNSET
    bucket_region: Union[Unset, str] = UNSET
    session_id: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        bucket_name = self.bucket_name

        bucket_endpoint = self.bucket_endpoint

        bucket_prefix = self.bucket_prefix

        bucket_region = self.bucket_region

        session_id = self.session_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if bucket_name is not UNSET:
            field_dict["bucketName"] = bucket_name
        if bucket_endpoint is not UNSET:
            field_dict["bucketEndpoint"] = bucket_endpoint
        if bucket_prefix is not UNSET:
            field_dict["bucketPrefix"] = bucket_prefix
        if bucket_region is not UNSET:
            field_dict["bucketRegion"] = bucket_region
        if session_id is not UNSET:
            field_dict["sessionId"] = session_id

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        bucket_name = d.pop("bucketName", UNSET)

        bucket_endpoint = d.pop("bucketEndpoint", UNSET)

        bucket_prefix = d.pop("bucketPrefix", UNSET)

        bucket_region = d.pop("bucketRegion", UNSET)

        session_id = d.pop("sessionId", UNSET)

        mount_config_response = cls(
            bucket_name=bucket_name,
            bucket_endpoint=bucket_endpoint,
            bucket_prefix=bucket_prefix,
            bucket_region=bucket_region,
            session_id=session_id,
        )

        mount_config_response.additional_properties = d
        return mount_config_response

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
