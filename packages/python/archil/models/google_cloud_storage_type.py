from enum import Enum


class GoogleCloudStorageType(str, Enum):
    GCS = "gcs"

    def __str__(self) -> str:
        return str(self.value)
