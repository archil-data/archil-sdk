from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.create_sandbox_request_env import CreateSandboxRequestEnv
    from ..models.sandbox_port_mapping import SandboxPortMapping


T = TypeVar("T", bound="CreateSandboxRequest")


@_attrs_define
class CreateSandboxRequest:
    """
    Attributes:
        vcpu_count (Union[Unset, int]):
        mem_size_mib (Union[Unset, int]):
        kernel (Union[Unset, str]):
        base_image (Union[Unset, str]): Public Linux OCI image reference. Docker shorthand and tags are accepted; the
            selected platform manifest is pinned at creation. Default: 'ubuntu:26.04'.
        port_mappings (Union[Unset, list['SandboxPortMapping']]):
        env (Union[Unset, CreateSandboxRequestEnv]): Environment variables applied to every exec
        max_ttl_seconds (Union[Unset, int]): Lifetime budget applied independently to each powered-on session
        max_concurrent_execs (Union[Unset, int]):
    """

    vcpu_count: Union[Unset, int] = UNSET
    mem_size_mib: Union[Unset, int] = UNSET
    kernel: Union[Unset, str] = UNSET
    base_image: Union[Unset, str] = "ubuntu:26.04"
    port_mappings: Union[Unset, list["SandboxPortMapping"]] = UNSET
    env: Union[Unset, "CreateSandboxRequestEnv"] = UNSET
    max_ttl_seconds: Union[Unset, int] = UNSET
    max_concurrent_execs: Union[Unset, int] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        vcpu_count = self.vcpu_count

        mem_size_mib = self.mem_size_mib

        kernel = self.kernel

        base_image = self.base_image

        port_mappings: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.port_mappings, Unset):
            port_mappings = []
            for port_mappings_item_data in self.port_mappings:
                port_mappings_item = port_mappings_item_data.to_dict()
                port_mappings.append(port_mappings_item)

        env: Union[Unset, dict[str, Any]] = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        max_ttl_seconds = self.max_ttl_seconds

        max_concurrent_execs = self.max_concurrent_execs

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if vcpu_count is not UNSET:
            field_dict["vcpu_count"] = vcpu_count
        if mem_size_mib is not UNSET:
            field_dict["mem_size_mib"] = mem_size_mib
        if kernel is not UNSET:
            field_dict["kernel"] = kernel
        if base_image is not UNSET:
            field_dict["base_image"] = base_image
        if port_mappings is not UNSET:
            field_dict["port_mappings"] = port_mappings
        if env is not UNSET:
            field_dict["env"] = env
        if max_ttl_seconds is not UNSET:
            field_dict["max_ttl_seconds"] = max_ttl_seconds
        if max_concurrent_execs is not UNSET:
            field_dict["max_concurrent_execs"] = max_concurrent_execs

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_sandbox_request_env import CreateSandboxRequestEnv
        from ..models.sandbox_port_mapping import SandboxPortMapping

        d = dict(src_dict)
        vcpu_count = d.pop("vcpu_count", UNSET)

        mem_size_mib = d.pop("mem_size_mib", UNSET)

        kernel = d.pop("kernel", UNSET)

        base_image = d.pop("base_image", UNSET)

        port_mappings = []
        _port_mappings = d.pop("port_mappings", UNSET)
        for port_mappings_item_data in _port_mappings or []:
            port_mappings_item = SandboxPortMapping.from_dict(port_mappings_item_data)

            port_mappings.append(port_mappings_item)

        _env = d.pop("env", UNSET)
        env: Union[Unset, CreateSandboxRequestEnv]
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = CreateSandboxRequestEnv.from_dict(_env)

        max_ttl_seconds = d.pop("max_ttl_seconds", UNSET)

        max_concurrent_execs = d.pop("max_concurrent_execs", UNSET)

        create_sandbox_request = cls(
            vcpu_count=vcpu_count,
            mem_size_mib=mem_size_mib,
            kernel=kernel,
            base_image=base_image,
            port_mappings=port_mappings,
            env=env,
            max_ttl_seconds=max_ttl_seconds,
            max_concurrent_execs=max_concurrent_execs,
        )

        create_sandbox_request.additional_properties = d
        return create_sandbox_request

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
