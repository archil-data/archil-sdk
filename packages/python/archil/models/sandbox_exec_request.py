from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.sandbox_exec_request_env import SandboxExecRequestEnv


T = TypeVar("T", bound="SandboxExecRequest")


@_attrs_define
class SandboxExecRequest:
    """
    Attributes:
        command (str): Shell command, run via `/bin/sh -c`
        command_tty (Union[Unset, bool]): Allocate a TTY for the command
        env (Union[Unset, SandboxExecRequestEnv]): Extra environment variables for this command
        timeout_seconds (Union[Unset, int]): Server-side execution deadline; the exec reports timed_out past it
    """

    command: str
    command_tty: Union[Unset, bool] = UNSET
    env: Union[Unset, "SandboxExecRequestEnv"] = UNSET
    timeout_seconds: Union[Unset, int] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        command = self.command

        command_tty = self.command_tty

        env: Union[Unset, dict[str, Any]] = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        timeout_seconds = self.timeout_seconds

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "command": command,
            }
        )
        if command_tty is not UNSET:
            field_dict["command_tty"] = command_tty
        if env is not UNSET:
            field_dict["env"] = env
        if timeout_seconds is not UNSET:
            field_dict["timeout_seconds"] = timeout_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.sandbox_exec_request_env import SandboxExecRequestEnv

        d = dict(src_dict)
        command = d.pop("command")

        command_tty = d.pop("command_tty", UNSET)

        _env = d.pop("env", UNSET)
        env: Union[Unset, SandboxExecRequestEnv]
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = SandboxExecRequestEnv.from_dict(_env)

        timeout_seconds = d.pop("timeout_seconds", UNSET)

        sandbox_exec_request = cls(
            command=command,
            command_tty=command_tty,
            env=env,
            timeout_seconds=timeout_seconds,
        )

        sandbox_exec_request.additional_properties = d
        return sandbox_exec_request

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
