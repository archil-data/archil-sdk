from enum import Enum


class CloudflareR2Type(str, Enum):
    R2 = "r2"

    def __str__(self) -> str:
        return str(self.value)
