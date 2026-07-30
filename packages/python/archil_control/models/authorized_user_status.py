from enum import Enum


class AuthorizedUserStatus(str, Enum):
    ACTIVE = "active"
    CONSUMED = "consumed"
    EXPIRED = "expired"

    def __str__(self) -> str:
        return str(self.value)
