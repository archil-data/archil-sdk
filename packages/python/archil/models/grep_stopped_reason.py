from enum import Enum


class GrepStoppedReason(str, Enum):
    COMPLETED = "completed"
    DEADLINE = "deadline"
    INCOMPLETE = "incomplete"
    LIST_FAILED = "list_failed"
    MAX_RESULTS = "max_results"

    def __str__(self) -> str:
        return str(self.value)
