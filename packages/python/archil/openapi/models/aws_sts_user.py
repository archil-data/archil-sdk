import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..models.aws_sts_user_type import AwsStsUserType
from ..types import UNSET, Unset

T = TypeVar("T", bound="AwsStsUser")


@_attrs_define
class AwsStsUser:
    """
    Attributes:
        type_ (AwsStsUserType):
        principal (str): IAM principal ARN
        ttl (Union[Unset, str]): Optional time-to-live as a Go duration string (e.g. "1h", "30m"). Maximum 365 days
            ("8760h"). Mutually exclusive with expiresAt.
        expires_at (Union[Unset, datetime.datetime]): Optional absolute expiration time as an RFC3339 timestamp. Must be
            in the future. Mutually exclusive with ttl.
        one_use (Union[Unset, bool]): When true, the credential can only be used for a single mount authentication.
        read_only (Union[Unset, bool]): When true, the credential grants read-only access. Mounts authenticated with
            this credential reject writes with EROFS.
    """

    type_: AwsStsUserType
    principal: str
    ttl: Union[Unset, str] = UNSET
    expires_at: Union[Unset, datetime.datetime] = UNSET
    one_use: Union[Unset, bool] = UNSET
    read_only: Union[Unset, bool] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        principal = self.principal

        ttl = self.ttl

        expires_at: Union[Unset, str] = UNSET
        if not isinstance(self.expires_at, Unset):
            expires_at = self.expires_at.isoformat()

        one_use = self.one_use

        read_only = self.read_only

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "principal": principal,
            }
        )
        if ttl is not UNSET:
            field_dict["ttl"] = ttl
        if expires_at is not UNSET:
            field_dict["expiresAt"] = expires_at
        if one_use is not UNSET:
            field_dict["oneUse"] = one_use
        if read_only is not UNSET:
            field_dict["readOnly"] = read_only

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = AwsStsUserType(d.pop("type"))

        principal = d.pop("principal")

        ttl = d.pop("ttl", UNSET)

        _expires_at = d.pop("expiresAt", UNSET)
        expires_at: Union[Unset, datetime.datetime]
        if isinstance(_expires_at, Unset):
            expires_at = UNSET
        else:
            expires_at = isoparse(_expires_at)

        one_use = d.pop("oneUse", UNSET)

        read_only = d.pop("readOnly", UNSET)

        aws_sts_user = cls(
            type_=type_,
            principal=principal,
            ttl=ttl,
            expires_at=expires_at,
            one_use=one_use,
            read_only=read_only,
        )

        aws_sts_user.additional_properties = d
        return aws_sts_user

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
