from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.authorized_user import AuthorizedUser


T = TypeVar("T", bound="ApiResponseCreateDiskData")


@_attrs_define
class ApiResponseCreateDiskData:
    """
    Attributes:
        disk_id (Union[Unset, str]):  Example: dsk-0123456789abcdef.
        authorized_users (Union[Unset, list['AuthorizedUser']]):
    """

    disk_id: Union[Unset, str] = UNSET
    authorized_users: Union[Unset, list["AuthorizedUser"]] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        disk_id = self.disk_id

        authorized_users: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.authorized_users, Unset):
            authorized_users = []
            for authorized_users_item_data in self.authorized_users:
                authorized_users_item = authorized_users_item_data.to_dict()
                authorized_users.append(authorized_users_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if disk_id is not UNSET:
            field_dict["diskId"] = disk_id
        if authorized_users is not UNSET:
            field_dict["authorizedUsers"] = authorized_users

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.authorized_user import AuthorizedUser

        d = dict(src_dict)
        disk_id = d.pop("diskId", UNSET)

        authorized_users = []
        _authorized_users = d.pop("authorizedUsers", UNSET)
        for authorized_users_item_data in _authorized_users or []:
            authorized_users_item = AuthorizedUser.from_dict(authorized_users_item_data)

            authorized_users.append(authorized_users_item)

        api_response_create_disk_data = cls(
            disk_id=disk_id,
            authorized_users=authorized_users,
        )

        api_response_create_disk_data.additional_properties = d
        return api_response_create_disk_data

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
