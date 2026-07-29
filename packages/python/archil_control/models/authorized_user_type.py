from enum import Enum


class AuthorizedUserType(str, Enum):
    AWSSTS = "awssts"
    TOKEN = "token"

    def __str__(self) -> str:
        return str(self.value)
