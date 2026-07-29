from enum import Enum


class AzureBlobStorageType(str, Enum):
    AZURE_BLOB = "azure-blob"

    def __str__(self) -> str:
        return str(self.value)
