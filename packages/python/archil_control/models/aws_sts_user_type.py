from enum import Enum


class AwsStsUserType(str, Enum):
    AWSSTS = "awssts"

    def __str__(self) -> str:
        return str(self.value)
