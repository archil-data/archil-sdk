from enum import Enum


class DiskResponseCapabilitiesItem(str, Enum):
    CHECKPOINTS = "checkpoints"

    def __str__(self) -> str:
        return str(self.value)
