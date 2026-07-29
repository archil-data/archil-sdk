from enum import Enum


class TokenUserType(str, Enum):
    TOKEN = "token"

    def __str__(self) -> str:
        return str(self.value)
