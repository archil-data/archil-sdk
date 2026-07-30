from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.api_token_response import ApiTokenResponse


T = TypeVar("T", bound="ApiResponseTokenListData")


@_attrs_define
class ApiResponseTokenListData:
    """
    Attributes:
        tokens (Union[Unset, list['ApiTokenResponse']]):
    """

    tokens: Union[Unset, list["ApiTokenResponse"]] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        tokens: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.tokens, Unset):
            tokens = []
            for tokens_item_data in self.tokens:
                tokens_item = tokens_item_data.to_dict()
                tokens.append(tokens_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if tokens is not UNSET:
            field_dict["tokens"] = tokens

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.api_token_response import ApiTokenResponse

        d = dict(src_dict)
        tokens = []
        _tokens = d.pop("tokens", UNSET)
        for tokens_item_data in _tokens or []:
            tokens_item = ApiTokenResponse.from_dict(tokens_item_data)

            tokens.append(tokens_item)

        api_response_token_list_data = cls(
            tokens=tokens,
        )

        api_response_token_list_data.additional_properties = d
        return api_response_token_list_data

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
