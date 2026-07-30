from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ApiResponseAllowedIPsData")


@_attrs_define
class ApiResponseAllowedIPsData:
    """
    Attributes:
        allowed_ips (list[str]):  Example: ['203.0.113.0/24', '198.51.100.42'].
    """

    allowed_ips: list[str]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        allowed_ips = self.allowed_ips

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "allowedIps": allowed_ips,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        allowed_ips = cast(list[str], d.pop("allowedIps"))

        api_response_allowed_i_ps_data = cls(
            allowed_ips=allowed_ips,
        )

        api_response_allowed_i_ps_data.additional_properties = d
        return api_response_allowed_i_ps_data

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
