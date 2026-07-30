from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.activity_event import ActivityEvent


T = TypeVar("T", bound="ApiResponseActivityList")


@_attrs_define
class ApiResponseActivityList:
    """
    Attributes:
        success (bool):  Example: True.
        data (list['ActivityEvent']):
        next_cursor (Union[Unset, str]): Set when more events remain beyond this page. Pass it back as the `cursor`
            query parameter to fetch the next page. Absent on the last page.
    """

    success: bool
    data: list["ActivityEvent"]
    next_cursor: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        success = self.success

        data = []
        for data_item_data in self.data:
            data_item = data_item_data.to_dict()
            data.append(data_item)

        next_cursor = self.next_cursor

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "success": success,
                "data": data,
            }
        )
        if next_cursor is not UNSET:
            field_dict["nextCursor"] = next_cursor

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.activity_event import ActivityEvent

        d = dict(src_dict)
        success = d.pop("success")

        data = []
        _data = d.pop("data")
        for data_item_data in _data:
            data_item = ActivityEvent.from_dict(data_item_data)

            data.append(data_item)

        next_cursor = d.pop("nextCursor", UNSET)

        api_response_activity_list = cls(
            success=success,
            data=data,
            next_cursor=next_cursor,
        )

        api_response_activity_list.additional_properties = d
        return api_response_activity_list

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
