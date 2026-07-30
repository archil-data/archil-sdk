import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..types import UNSET, Unset

T = TypeVar("T", bound="ConnectedClient")


@_attrs_define
class ConnectedClient:
    """
    Attributes:
        id (Union[Unset, str]):
        ip_address (Union[Unset, str]):
        connected_at (Union[Unset, datetime.datetime]):
    """

    id: Union[Unset, str] = UNSET
    ip_address: Union[Unset, str] = UNSET
    connected_at: Union[Unset, datetime.datetime] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        ip_address = self.ip_address

        connected_at: Union[Unset, str] = UNSET
        if not isinstance(self.connected_at, Unset):
            connected_at = self.connected_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if id is not UNSET:
            field_dict["id"] = id
        if ip_address is not UNSET:
            field_dict["ipAddress"] = ip_address
        if connected_at is not UNSET:
            field_dict["connectedAt"] = connected_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id", UNSET)

        ip_address = d.pop("ipAddress", UNSET)

        _connected_at = d.pop("connectedAt", UNSET)
        connected_at: Union[Unset, datetime.datetime]
        if isinstance(_connected_at, Unset):
            connected_at = UNSET
        else:
            connected_at = isoparse(_connected_at)

        connected_client = cls(
            id=id,
            ip_address=ip_address,
            connected_at=connected_at,
        )

        connected_client.additional_properties = d
        return connected_client

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
