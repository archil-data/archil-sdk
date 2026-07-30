from enum import Enum


class SandboxExecState(str, Enum):
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    FAILED = "failed"
    RUNNING = "running"
    TIMED_OUT = "timed_out"

    def __str__(self) -> str:
        return str(self.value)
