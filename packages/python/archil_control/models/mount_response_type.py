from enum import Enum


class MountResponseType(str, Enum):
    AZURE_BLOB = "azure-blob"
    GCS = "gcs"
    R2 = "r2"
    S3 = "s3"
    S3_COMPATIBLE = "s3-compatible"

    def __str__(self) -> str:
        return str(self.value)
