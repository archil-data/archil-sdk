from enum import Enum


class DiskResponseStatus(str, Enum):
    AVAILABLE = "available"
    CREATING = "creating"
    DELETED = "deleted"
    DELETING = "deleting"
    FAILED = "failed"

    def __str__(self) -> str:
        return str(self.value)
