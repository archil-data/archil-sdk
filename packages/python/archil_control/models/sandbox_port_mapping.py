from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.sandbox_port_mapping_protocol import SandboxPortMappingProtocol

T = TypeVar("T", bound="SandboxPortMapping")


@_attrs_define
class SandboxPortMapping:
    """
    Attributes:
        container_port (int):
        protocol (SandboxPortMappingProtocol):
    """

    container_port: int
    protocol: SandboxPortMappingProtocol
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        container_port = self.container_port

        protocol = self.protocol.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "container_port": container_port,
                "protocol": protocol,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        container_port = d.pop("container_port")

        protocol = SandboxPortMappingProtocol(d.pop("protocol"))

        sandbox_port_mapping = cls(
            container_port=container_port,
            protocol=protocol,
        )

        sandbox_port_mapping.additional_properties = d
        return sandbox_port_mapping

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
