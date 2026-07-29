from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

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
    """

    type_: TokenUserType
    nickname: str
    principal: Union[Unset, str] = UNSET
    token_suffix: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        nickname = self.nickname

        principal = self.principal

        token_suffix = self.token_suffix

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

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = TokenUserType(d.pop("type"))

        nickname = d.pop("nickname")

        principal = d.pop("principal", UNSET)

        token_suffix = d.pop("tokenSuffix", UNSET)

        token_user = cls(
            type_=type_,
            nickname=nickname,
            principal=principal,
            token_suffix=token_suffix,
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
