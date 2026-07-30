from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ExecTiming")


@_attrs_define
class ExecTiming:
    """Server-measured timings for an exec request.

    Attributes:
        total_ms (int): End-to-end wall clock measured on the server, from request arrival to response.
             Example: 2450.
        queue_ms (int): Time spent queueing, scheduling, booting/claiming a VM, and mounting the filesystem before the
            command started running.
             Example: 150.
        execute_ms (int): Time the user's command itself ran, measured by the runtime.
             Example: 2300.
    """

    total_ms: int
    queue_ms: int
    execute_ms: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        total_ms = self.total_ms

        queue_ms = self.queue_ms

        execute_ms = self.execute_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "totalMs": total_ms,
                "queueMs": queue_ms,
                "executeMs": execute_ms,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        total_ms = d.pop("totalMs")

        queue_ms = d.pop("queueMs")

        execute_ms = d.pop("executeMs")

        exec_timing = cls(
            total_ms=total_ms,
            queue_ms=queue_ms,
            execute_ms=execute_ms,
        )

        exec_timing.additional_properties = d
        return exec_timing

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
