from enum import Enum


class MountResponseAuthorizationType(str, Enum):
    ACCESSKEYS = "accessKeys"
    IAM = "iam"
    OAUTH = "oauth"

    def __str__(self) -> str:
        return str(self.value)
