from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="DelegationEntry")


@_attrs_define
class DelegationEntry:
    """
    Attributes:
        client_id (str): ID of the client holding the delegation. Example: 12345.
        inode_id (int): Inode the delegation covers.
        is_pending (bool): True while the delegation checkout is still in flight.
        is_orphaned (bool): True when the holding client is no longer connected to the disk.
        path (Union[Unset, str]): Absolute path of the inode, resolved best-effort. Omitted when the server could not
            resolve it.
             Example: workspace/data.db.
    """

    client_id: str
    inode_id: int
    is_pending: bool
    is_orphaned: bool
    path: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        client_id = self.client_id

        inode_id = self.inode_id

        is_pending = self.is_pending

        is_orphaned = self.is_orphaned

        path = self.path

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "clientId": client_id,
                "inodeId": inode_id,
                "isPending": is_pending,
                "isOrphaned": is_orphaned,
            }
        )
        if path is not UNSET:
            field_dict["path"] = path

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        client_id = d.pop("clientId")

        inode_id = d.pop("inodeId")

        is_pending = d.pop("isPending")

        is_orphaned = d.pop("isOrphaned")

        path = d.pop("path", UNSET)

        delegation_entry = cls(
            client_id=client_id,
            inode_id=inode_id,
            is_pending=is_pending,
            is_orphaned=is_orphaned,
            path=path,
        )

        delegation_entry.additional_properties = d
        return delegation_entry

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
