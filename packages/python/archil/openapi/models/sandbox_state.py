from enum import Enum


class SandboxState(str, Enum):
    EXITED = "exited"
    FAILED = "failed"
    PAUSED = "paused"
    PAUSING = "pausing"
    PENDING = "pending"
    RUNNING = "running"
    STOPPED = "stopped"
    STOPPING = "stopping"

    def __str__(self) -> str:
        return str(self.value)
