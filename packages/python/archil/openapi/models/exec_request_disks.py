from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.exec_mount import ExecMount


T = TypeVar("T", bound="ExecRequestDisks")


@_attrs_define
class ExecRequestDisks:
    """Map of relative path under `/mnt/archil` to the disk to mount
    there. At least one entry is required. Relative paths must be
    non-empty, non-absolute, and contain no `.` or `..` segments.

    Each value is either a plain disk ID string (mounts the disk's
    root, read-write) or an object that additionally selects a
    subdirectory of the disk and/or marks the mount as read-only,
    conditional, or requests delegation checkouts before the command
    starts. `checkoutPaths` are relative to that disk's exposed mount
    root. `queueMs` is an optional timeout for delegation acquisition;
    with `checkoutPaths`, it applies to each requested checkout, and
    without `checkoutPaths`, the mount root is acquired during mount
    setup. Delegation checkout options are rejected with `readOnly:
    true`.

        Example:
            {'data': 'dsk-abc123', 'logs': {'disk': 'dsk-def456', 'subdirectory': 'app/logs', 'readOnly': True}}

    """

    additional_properties: dict[str, Union["ExecMount", str]] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.exec_mount import ExecMount

        field_dict: dict[str, Any] = {}
        for prop_name, prop in self.additional_properties.items():
            if isinstance(prop, ExecMount):
                field_dict[prop_name] = prop.to_dict()
            else:
                field_dict[prop_name] = prop

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.exec_mount import ExecMount

        d = dict(src_dict)
        exec_request_disks = cls()

        additional_properties = {}
        for prop_name, prop_dict in d.items():

            def _parse_additional_property(data: object) -> Union["ExecMount", str]:
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    additional_property_type_1 = ExecMount.from_dict(data)

                    return additional_property_type_1
                except:  # noqa: E722
                    pass
                return cast(Union["ExecMount", str], data)

            additional_property = _parse_additional_property(prop_dict)

            additional_properties[prop_name] = additional_property

        exec_request_disks.additional_properties = additional_properties
        return exec_request_disks

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Union["ExecMount", str]:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Union["ExecMount", str]) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
