from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.sandbox import Sandbox


T = TypeVar("T", bound="ApiResponseSandboxListData")


@_attrs_define
class ApiResponseSandboxListData:
    """
    Attributes:
        sandboxes (Union[Unset, list['Sandbox']]):
    """

    sandboxes: Union[Unset, list["Sandbox"]] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        sandboxes: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.sandboxes, Unset):
            sandboxes = []
            for sandboxes_item_data in self.sandboxes:
                sandboxes_item = sandboxes_item_data.to_dict()
                sandboxes.append(sandboxes_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if sandboxes is not UNSET:
            field_dict["sandboxes"] = sandboxes

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.sandbox import Sandbox

        d = dict(src_dict)
        sandboxes = []
        _sandboxes = d.pop("sandboxes", UNSET)
        for sandboxes_item_data in _sandboxes or []:
            sandboxes_item = Sandbox.from_dict(sandboxes_item_data)

            sandboxes.append(sandboxes_item)

        api_response_sandbox_list_data = cls(
            sandboxes=sandboxes,
        )

        api_response_sandbox_list_data.additional_properties = d
        return api_response_sandbox_list_data

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
