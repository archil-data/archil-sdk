from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.exec_request_disks import ExecRequestDisks


T = TypeVar("T", bound="ExecRequest")


@_attrs_define
class ExecRequest:
    """
    Attributes:
        disks (ExecRequestDisks): Map of relative path under `/mnt/archil` to the disk to mount
            there. At least one entry is required. Relative paths must be
            non-empty, non-absolute, and contain no `.` or `..` segments.

            Each value is either a plain disk ID string (mounts the disk's
            root, read-write) or an object that additionally selects a
            subdirectory of the disk and/or marks the mount as read-only.
             Example: {'data': 'dsk-abc123', 'logs': {'disk': 'dsk-def456', 'subdirectory': 'app/logs', 'readOnly': True}}.
        command (str): Shell command to execute inside the container Example: ls -la /mnt/archil/data /mnt/archil/logs.
    """

    disks: "ExecRequestDisks"
    command: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        disks = self.disks.to_dict()

        command = self.command

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "disks": disks,
                "command": command,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.exec_request_disks import ExecRequestDisks

        d = dict(src_dict)
        disks = ExecRequestDisks.from_dict(d.pop("disks"))

        command = d.pop("command")

        exec_request = cls(
            disks=disks,
            command=command,
        )

        exec_request.additional_properties = d
        return exec_request

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
