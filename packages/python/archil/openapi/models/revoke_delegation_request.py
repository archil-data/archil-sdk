from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="RevokeDelegationRequest")


@_attrs_define
class RevokeDelegationRequest:
    """
    Attributes:
        inode_id (int): Inode the delegation covers.
        client_id (str): ID of the client holding the delegation. Example: 12345.
    """

    inode_id: int
    client_id: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        inode_id = self.inode_id

        client_id = self.client_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "inodeId": inode_id,
                "clientId": client_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        inode_id = d.pop("inodeId")

        client_id = d.pop("clientId")

        revoke_delegation_request = cls(
            inode_id=inode_id,
            client_id=client_id,
        )

        revoke_delegation_request.additional_properties = d
        return revoke_delegation_request

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
