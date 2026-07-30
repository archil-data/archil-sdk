import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, Union
from uuid import UUID

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..models.sandbox_exec_state import SandboxExecState
from ..types import UNSET, Unset

T = TypeVar("T", bound="SandboxExec")


@_attrs_define
class SandboxExec:
    """
    Attributes:
        sandbox_id (UUID):
        exec_id (UUID):
        command (str):
        status (SandboxExecState):
        started_at (datetime.datetime):
        exit_code (Union[Unset, int]):
        stdout (Union[Unset, str]):
        stderr (Union[Unset, str]):
        exit_reason (Union[Unset, str]):
        execute_time_ms (Union[Unset, int]):
        finished_at (Union[Unset, datetime.datetime]):
    """

    sandbox_id: UUID
    exec_id: UUID
    command: str
    status: SandboxExecState
    started_at: datetime.datetime
    exit_code: Union[Unset, int] = UNSET
    stdout: Union[Unset, str] = UNSET
    stderr: Union[Unset, str] = UNSET
    exit_reason: Union[Unset, str] = UNSET
    execute_time_ms: Union[Unset, int] = UNSET
    finished_at: Union[Unset, datetime.datetime] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        sandbox_id = str(self.sandbox_id)

        exec_id = str(self.exec_id)

        command = self.command

        status = self.status.value

        started_at = self.started_at.isoformat()

        exit_code = self.exit_code

        stdout = self.stdout

        stderr = self.stderr

        exit_reason = self.exit_reason

        execute_time_ms = self.execute_time_ms

        finished_at: Union[Unset, str] = UNSET
        if not isinstance(self.finished_at, Unset):
            finished_at = self.finished_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "sandbox_id": sandbox_id,
                "exec_id": exec_id,
                "command": command,
                "status": status,
                "started_at": started_at,
            }
        )
        if exit_code is not UNSET:
            field_dict["exit_code"] = exit_code
        if stdout is not UNSET:
            field_dict["stdout"] = stdout
        if stderr is not UNSET:
            field_dict["stderr"] = stderr
        if exit_reason is not UNSET:
            field_dict["exit_reason"] = exit_reason
        if execute_time_ms is not UNSET:
            field_dict["execute_time_ms"] = execute_time_ms
        if finished_at is not UNSET:
            field_dict["finished_at"] = finished_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        sandbox_id = UUID(d.pop("sandbox_id"))

        exec_id = UUID(d.pop("exec_id"))

        command = d.pop("command")

        status = SandboxExecState(d.pop("status"))

        started_at = isoparse(d.pop("started_at"))

        exit_code = d.pop("exit_code", UNSET)

        stdout = d.pop("stdout", UNSET)

        stderr = d.pop("stderr", UNSET)

        exit_reason = d.pop("exit_reason", UNSET)

        execute_time_ms = d.pop("execute_time_ms", UNSET)

        _finished_at = d.pop("finished_at", UNSET)
        finished_at: Union[Unset, datetime.datetime]
        if isinstance(_finished_at, Unset):
            finished_at = UNSET
        else:
            finished_at = isoparse(_finished_at)

        sandbox_exec = cls(
            sandbox_id=sandbox_id,
            exec_id=exec_id,
            command=command,
            status=status,
            started_at=started_at,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            exit_reason=exit_reason,
            execute_time_ms=execute_time_ms,
            finished_at=finished_at,
        )

        sandbox_exec.additional_properties = d
        return sandbox_exec

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
