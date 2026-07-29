from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="DiskMetrics")


@_attrs_define
class DiskMetrics:
    """
    Attributes:
        data_transfer (Union[Unset, str]): Data transfer amount with unit (e.g., "1.5 GB")
        requests (Union[Unset, str]): Total request count as a formatted string (e.g., "1,234")
        avg_response_time (Union[Unset, str]): Average response time with unit (e.g., "45ms")
    """

    data_transfer: Union[Unset, str] = UNSET
    requests: Union[Unset, str] = UNSET
    avg_response_time: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data_transfer = self.data_transfer

        requests = self.requests

        avg_response_time = self.avg_response_time

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if data_transfer is not UNSET:
            field_dict["dataTransfer"] = data_transfer
        if requests is not UNSET:
            field_dict["requests"] = requests
        if avg_response_time is not UNSET:
            field_dict["avgResponseTime"] = avg_response_time

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        data_transfer = d.pop("dataTransfer", UNSET)

        requests = d.pop("requests", UNSET)

        avg_response_time = d.pop("avgResponseTime", UNSET)

        disk_metrics = cls(
            data_transfer=data_transfer,
            requests=requests,
            avg_response_time=avg_response_time,
        )

        disk_metrics.additional_properties = d
        return disk_metrics

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
