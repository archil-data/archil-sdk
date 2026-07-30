import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..models.token_user_type import TokenUserType
from ..types import UNSET, Unset

T = TypeVar("T", bound="TokenUser")


@_attrs_define
class TokenUser:
    """
    Attributes:
        type_ (TokenUserType):
        nickname (str):
        principal (Union[Unset, str]): Deprecated. Client-provided token. If omitted, the server generates a
            cryptographically secure token and returns it in the response.
        token_suffix (Union[Unset, str]): Deprecated. Last 4 characters of the token. Required when principal is
            provided; ignored when the server generates the token.
        ttl (Union[Unset, str]): Optional time-to-live for the token as a Go duration string (e.g. "1h", "30m", "24h").
            The server computes expiresAt = now + ttl. Maximum 365 days ("8760h"). Expired tokens are rejected at mount time
            but remain visible in the disk's authorized users list. Mutually exclusive with expiresAt.
        expires_at (Union[Unset, datetime.datetime]): Optional absolute expiration time as an RFC3339 timestamp (e.g.
            "2026-07-15T00:00:00Z"). Must be in the future. Mutually exclusive with ttl.
        one_use (Union[Unset, bool]): When true, the token can only be used for a single mount authentication. After the
            first successful mount, subsequent attempts are rejected. Consumed tokens remain visible in the disk's
            authorized users list.
        read_only (Union[Unset, bool]): When true, the token grants read-only access. Mounts authenticated with this
            token reject writes with EROFS.
    """

    type_: TokenUserType
    nickname: str
    principal: Union[Unset, str] = UNSET
    token_suffix: Union[Unset, str] = UNSET
    ttl: Union[Unset, str] = UNSET
    expires_at: Union[Unset, datetime.datetime] = UNSET
    one_use: Union[Unset, bool] = UNSET
    read_only: Union[Unset, bool] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        nickname = self.nickname

        principal = self.principal

        token_suffix = self.token_suffix

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
                "nickname": nickname,
            }
        )
        if principal is not UNSET:
            field_dict["principal"] = principal
        if token_suffix is not UNSET:
            field_dict["tokenSuffix"] = token_suffix
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
        type_ = TokenUserType(d.pop("type"))

        nickname = d.pop("nickname")

        principal = d.pop("principal", UNSET)

        token_suffix = d.pop("tokenSuffix", UNSET)

        ttl = d.pop("ttl", UNSET)

        _expires_at = d.pop("expiresAt", UNSET)
        expires_at: Union[Unset, datetime.datetime]
        if isinstance(_expires_at, Unset):
            expires_at = UNSET
        else:
            expires_at = isoparse(_expires_at)

        one_use = d.pop("oneUse", UNSET)

        read_only = d.pop("readOnly", UNSET)

        token_user = cls(
            type_=type_,
            nickname=nickname,
            principal=principal,
            token_suffix=token_suffix,
            ttl=ttl,
            expires_at=expires_at,
            one_use=one_use,
            read_only=read_only,
        )

        token_user.additional_properties = d
        return token_user

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
