from enum import Enum


class MountResponseAccessMode(str, Enum):
    RO = "ro"
    RW = "rw"

    def __str__(self) -> str:
        return str(self.value)
