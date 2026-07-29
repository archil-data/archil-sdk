import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..models.authorized_user_type import AuthorizedUserType
from ..types import UNSET, Unset

T = TypeVar("T", bound="AuthorizedUser")


@_attrs_define
class AuthorizedUser:
    """
    Attributes:
        type_ (Union[Unset, AuthorizedUserType]):
        principal (Union[Unset, str]): Use identifier instead. Only populated for awssts type (the IAM ARN).
        nickname (Union[Unset, str]):
        token_suffix (Union[Unset, str]):
        token (Union[Unset, str]): The generated disk token (used by clients when mounting the disk). Only present in
            the response when the server generates the token (i.e. principal was not provided). This value is shown exactly
            once and cannot be retrieved again.
        identifier (Union[Unset, str]): Stable identifier for this user, returned in creation and list responses. Use
            this value with DELETE /api/disks/{id}/users/{type}?identifier={identifier} to remove the user. For awssts
            users, this is the IAM ARN.
        created_at (Union[Unset, datetime.datetime]):
    """

    type_: Union[Unset, AuthorizedUserType] = UNSET
    principal: Union[Unset, str] = UNSET
    nickname: Union[Unset, str] = UNSET
    token_suffix: Union[Unset, str] = UNSET
    token: Union[Unset, str] = UNSET
    identifier: Union[Unset, str] = UNSET
    created_at: Union[Unset, datetime.datetime] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_: Union[Unset, str] = UNSET
        if not isinstance(self.type_, Unset):
            type_ = self.type_.value

        principal = self.principal

        nickname = self.nickname

        token_suffix = self.token_suffix

        token = self.token

        identifier = self.identifier

        created_at: Union[Unset, str] = UNSET
        if not isinstance(self.created_at, Unset):
            created_at = self.created_at.isoformat()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if type_ is not UNSET:
            field_dict["type"] = type_
        if principal is not UNSET:
            field_dict["principal"] = principal
        if nickname is not UNSET:
            field_dict["nickname"] = nickname
        if token_suffix is not UNSET:
            field_dict["tokenSuffix"] = token_suffix
        if token is not UNSET:
            field_dict["token"] = token
        if identifier is not UNSET:
            field_dict["identifier"] = identifier
        if created_at is not UNSET:
            field_dict["createdAt"] = created_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        _type_ = d.pop("type", UNSET)
        type_: Union[Unset, AuthorizedUserType]
        if isinstance(_type_, Unset):
            type_ = UNSET
        else:
            type_ = AuthorizedUserType(_type_)

        principal = d.pop("principal", UNSET)

        nickname = d.pop("nickname", UNSET)

        token_suffix = d.pop("tokenSuffix", UNSET)

        token = d.pop("token", UNSET)

        identifier = d.pop("identifier", UNSET)

        _created_at = d.pop("createdAt", UNSET)
        created_at: Union[Unset, datetime.datetime]
        if isinstance(_created_at, Unset):
            created_at = UNSET
        else:
            created_at = isoparse(_created_at)

        authorized_user = cls(
            type_=type_,
            principal=principal,
            nickname=nickname,
            token_suffix=token_suffix,
            token=token,
            identifier=identifier,
            created_at=created_at,
        )

        authorized_user.additional_properties = d
        return authorized_user

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
