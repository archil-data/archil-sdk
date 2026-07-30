from enum import Enum


class S3CompatibleType(str, Enum):
    S3_COMPATIBLE = "s3-compatible"

    def __str__(self) -> str:
        return str(self.value)
