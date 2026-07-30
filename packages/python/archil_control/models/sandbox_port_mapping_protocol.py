from enum import Enum


class SandboxPortMappingProtocol(str, Enum):
    TCP = "tcp"
    UDP = "udp"

    def __str__(self) -> str:
        return str(self.value)
