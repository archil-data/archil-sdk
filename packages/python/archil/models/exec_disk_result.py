from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.exec_timing import ExecTiming


T = TypeVar("T", bound="ExecDiskResult")


@_attrs_define
class ExecDiskResult:
    """
    Attributes:
        exit_code (int): Exit code of the command (0 = success)
        stdout (str): Standard output from the command
        stderr (str): Standard error from the command
        timing (ExecTiming): Server-measured timings for an exec request.
    """

    exit_code: int
    stdout: str
    stderr: str
    timing: "ExecTiming"
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        exit_code = self.exit_code

        stdout = self.stdout

        stderr = self.stderr

        timing = self.timing.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "timing": timing,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.exec_timing import ExecTiming

        d = dict(src_dict)
        exit_code = d.pop("exitCode")

        stdout = d.pop("stdout")

        stderr = d.pop("stderr")

        timing = ExecTiming.from_dict(d.pop("timing"))

        exec_disk_result = cls(
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            timing=timing,
        )

        exec_disk_result.additional_properties = d
        return exec_disk_result

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
