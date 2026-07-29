from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.disk_response import DiskResponse


T = TypeVar("T", bound="ApiResponseDiskList")


@_attrs_define
class ApiResponseDiskList:
    """All API responses use a standard envelope with `success: boolean` and `data` (on success) or `error: string` (on
    failure). The ApiResponse_* schemas each define the specific `data` shape for their endpoint.

        Attributes:
            success (bool):  Example: True.
            data (list['DiskResponse']):
    """

    success: bool
    data: list["DiskResponse"]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        success = self.success

        data = []
        for data_item_data in self.data:
            data_item = data_item_data.to_dict()
            data.append(data_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "success": success,
                "data": data,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.disk_response import DiskResponse

        d = dict(src_dict)
        success = d.pop("success")

        data = []
        _data = d.pop("data")
        for data_item_data in _data:
            data_item = DiskResponse.from_dict(data_item_data)

            data.append(data_item)

        api_response_disk_list = cls(
            success=success,
            data=data,
        )

        api_response_disk_list.additional_properties = d
        return api_response_disk_list

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
