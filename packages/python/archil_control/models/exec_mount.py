from collections.abc import Mapping
from typing import Any, TypeVar, Union, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="ExecMount")


@_attrs_define
class ExecMount:
    """
    Attributes:
        disk (str): Disk ID to mount at this relative path Example: dsk-abc123.
        subdirectory (Union[Unset, str]): Subdirectory of the disk to expose at the mountpoint. Must be a
            relative path with no `.` or `..` segments. When omitted, the
            disk's root is exposed.
             Example: app/logs.
        read_only (Union[Unset, bool]): When true, the disk is mounted read-only inside the container.
            Writes against the mount fail with EROFS.
             Default: False.
        conditional (Union[Unset, bool]): When true, the disk is mounted in conditional mode, where mutating
            operations are sent directly to the server without a delegation
            checkout. This enables concurrent writes from multiple clients to
            the same disk.
             Default: False.
        queue_ms (Union[Unset, int]): Optional delegation checkout queue timeout, in milliseconds. With
            `checkoutPaths`, it applies to each requested checkout. Without
            `checkoutPaths`, the exposed mount root is acquired during mount
            setup. Rejected with `readOnly: true`.
        checkout_paths (Union[Unset, list[str]]): Paths relative to this disk's exposed mount root to check out before
            the command starts. May be set without `queueMs`; those checkouts
            try immediately without waiting in the delegation queue. Rejected
            with `readOnly: true`.
             Example: ['src', 'tmp/cache'].
    """

    disk: str
    subdirectory: Union[Unset, str] = UNSET
    read_only: Union[Unset, bool] = False
    conditional: Union[Unset, bool] = False
    queue_ms: Union[Unset, int] = UNSET
    checkout_paths: Union[Unset, list[str]] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        disk = self.disk

        subdirectory = self.subdirectory

        read_only = self.read_only

        conditional = self.conditional

        queue_ms = self.queue_ms

        checkout_paths: Union[Unset, list[str]] = UNSET
        if not isinstance(self.checkout_paths, Unset):
            checkout_paths = self.checkout_paths

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "disk": disk,
            }
        )
        if subdirectory is not UNSET:
            field_dict["subdirectory"] = subdirectory
        if read_only is not UNSET:
            field_dict["readOnly"] = read_only
        if conditional is not UNSET:
            field_dict["conditional"] = conditional
        if queue_ms is not UNSET:
            field_dict["queueMs"] = queue_ms
        if checkout_paths is not UNSET:
            field_dict["checkoutPaths"] = checkout_paths

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        disk = d.pop("disk")

        subdirectory = d.pop("subdirectory", UNSET)

        read_only = d.pop("readOnly", UNSET)

        conditional = d.pop("conditional", UNSET)

        queue_ms = d.pop("queueMs", UNSET)

        checkout_paths = cast(list[str], d.pop("checkoutPaths", UNSET))

        exec_mount = cls(
            disk=disk,
            subdirectory=subdirectory,
            read_only=read_only,
            conditional=conditional,
            queue_ms=queue_ms,
            checkout_paths=checkout_paths,
        )

        exec_mount.additional_properties = d
        return exec_mount

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
