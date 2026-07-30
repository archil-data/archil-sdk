import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union
from uuid import UUID

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..models.sandbox_platform import SandboxPlatform
from ..models.sandbox_state import SandboxState
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.sandbox_endpoint import SandboxEndpoint


T = TypeVar("T", bound="Sandbox")


@_attrs_define
class Sandbox:
    """
    Attributes:
        sandbox_id (UUID):
        status (SandboxState):
        vcpu_count (int):
        mem_size_mib (int):
        max_ttl_seconds (int): Full lifetime budget applied independently to each powered-on session.
        max_concurrent_execs (int):
        base_image (str): OCI reference requested when the sandbox was created.
        created_at (datetime.datetime):
        last_active_at (datetime.datetime):
        platform (Union[Unset, SandboxPlatform]): Sandbox CPU architecture.
        endpoints (Union[Unset, list['SandboxEndpoint']]):
        running_at (Union[Unset, datetime.datetime]):
        finished_at (Union[Unset, datetime.datetime]):
        expires_at (Union[Unset, datetime.datetime]): Current powered-on session deadline; absent while inactive.
        exit_reason (Union[Unset, str]):
    """

    sandbox_id: UUID
    status: SandboxState
    vcpu_count: int
    mem_size_mib: int
    max_ttl_seconds: int
    max_concurrent_execs: int
    base_image: str
    created_at: datetime.datetime
    last_active_at: datetime.datetime
    platform: Union[Unset, SandboxPlatform] = UNSET
    endpoints: Union[Unset, list["SandboxEndpoint"]] = UNSET
    running_at: Union[Unset, datetime.datetime] = UNSET
    finished_at: Union[Unset, datetime.datetime] = UNSET
    expires_at: Union[Unset, datetime.datetime] = UNSET
    exit_reason: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        sandbox_id = str(self.sandbox_id)

        status = self.status.value

        vcpu_count = self.vcpu_count

        mem_size_mib = self.mem_size_mib

        max_ttl_seconds = self.max_ttl_seconds

        max_concurrent_execs = self.max_concurrent_execs

        base_image = self.base_image

        created_at = self.created_at.isoformat()

        last_active_at = self.last_active_at.isoformat()

        platform: Union[Unset, str] = UNSET
        if not isinstance(self.platform, Unset):
            platform = self.platform.value

        endpoints: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.endpoints, Unset):
            endpoints = []
            for endpoints_item_data in self.endpoints:
                endpoints_item = endpoints_item_data.to_dict()
                endpoints.append(endpoints_item)

        running_at: Union[Unset, str] = UNSET
        if not isinstance(self.running_at, Unset):
            running_at = self.running_at.isoformat()

        finished_at: Union[Unset, str] = UNSET
        if not isinstance(self.finished_at, Unset):
            finished_at = self.finished_at.isoformat()

        expires_at: Union[Unset, str] = UNSET
        if not isinstance(self.expires_at, Unset):
            expires_at = self.expires_at.isoformat()

        exit_reason = self.exit_reason

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "sandbox_id": sandbox_id,
                "status": status,
                "vcpu_count": vcpu_count,
                "mem_size_mib": mem_size_mib,
                "max_ttl_seconds": max_ttl_seconds,
                "max_concurrent_execs": max_concurrent_execs,
                "base_image": base_image,
                "created_at": created_at,
                "last_active_at": last_active_at,
            }
        )
        if platform is not UNSET:
            field_dict["platform"] = platform
        if endpoints is not UNSET:
            field_dict["endpoints"] = endpoints
        if running_at is not UNSET:
            field_dict["running_at"] = running_at
        if finished_at is not UNSET:
            field_dict["finished_at"] = finished_at
        if expires_at is not UNSET:
            field_dict["expires_at"] = expires_at
        if exit_reason is not UNSET:
            field_dict["exit_reason"] = exit_reason

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.sandbox_endpoint import SandboxEndpoint

        d = dict(src_dict)
        sandbox_id = UUID(d.pop("sandbox_id"))

        status = SandboxState(d.pop("status"))

        vcpu_count = d.pop("vcpu_count")

        mem_size_mib = d.pop("mem_size_mib")

        max_ttl_seconds = d.pop("max_ttl_seconds")

        max_concurrent_execs = d.pop("max_concurrent_execs")

        base_image = d.pop("base_image")

        created_at = isoparse(d.pop("created_at"))

        last_active_at = isoparse(d.pop("last_active_at"))

        _platform = d.pop("platform", UNSET)
        platform: Union[Unset, SandboxPlatform]
        if isinstance(_platform, Unset):
            platform = UNSET
        else:
            platform = SandboxPlatform(_platform)

        endpoints = []
        _endpoints = d.pop("endpoints", UNSET)
        for endpoints_item_data in _endpoints or []:
            endpoints_item = SandboxEndpoint.from_dict(endpoints_item_data)

            endpoints.append(endpoints_item)

        _running_at = d.pop("running_at", UNSET)
        running_at: Union[Unset, datetime.datetime]
        if isinstance(_running_at, Unset):
            running_at = UNSET
        else:
            running_at = isoparse(_running_at)

        _finished_at = d.pop("finished_at", UNSET)
        finished_at: Union[Unset, datetime.datetime]
        if isinstance(_finished_at, Unset):
            finished_at = UNSET
        else:
            finished_at = isoparse(_finished_at)

        _expires_at = d.pop("expires_at", UNSET)
        expires_at: Union[Unset, datetime.datetime]
        if isinstance(_expires_at, Unset):
            expires_at = UNSET
        else:
            expires_at = isoparse(_expires_at)

        exit_reason = d.pop("exit_reason", UNSET)

        sandbox = cls(
            sandbox_id=sandbox_id,
            status=status,
            vcpu_count=vcpu_count,
            mem_size_mib=mem_size_mib,
            max_ttl_seconds=max_ttl_seconds,
            max_concurrent_execs=max_concurrent_execs,
            base_image=base_image,
            created_at=created_at,
            last_active_at=last_active_at,
            platform=platform,
            endpoints=endpoints,
            running_at=running_at,
            finished_at=finished_at,
            expires_at=expires_at,
            exit_reason=exit_reason,
        )

        sandbox.additional_properties = d
        return sandbox

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
