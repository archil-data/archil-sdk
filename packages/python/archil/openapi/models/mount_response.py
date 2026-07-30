from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.mount_response_access_mode import MountResponseAccessMode
from ..models.mount_response_authorization_type import MountResponseAuthorizationType
from ..models.mount_response_connection_status import MountResponseConnectionStatus
from ..models.mount_response_type import MountResponseType
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.mount_config_response import MountConfigResponse


T = TypeVar("T", bound="MountResponse")


@_attrs_define
class MountResponse:
    """
    Attributes:
        id (Union[Unset, str]): Mount identifier
        type_ (Union[Unset, MountResponseType]): Storage backend type
        path (Union[Unset, str]): Mount path
        name (Union[Unset, str]): Bucket/container name
        access_mode (Union[Unset, MountResponseAccessMode]): Access mode Example: rw.
        config (Union[Unset, MountConfigResponse]): Mount configuration details (secrets omitted)
        connection_status (Union[Unset, MountResponseConnectionStatus]): Current connection status
        auth_error (Union[Unset, str]): Authentication error message (if disconnected)
        authorization_type (Union[Unset, MountResponseAuthorizationType]): How the mount authenticates to the storage
            backend
    """

    id: Union[Unset, str] = UNSET
    type_: Union[Unset, MountResponseType] = UNSET
    path: Union[Unset, str] = UNSET
    name: Union[Unset, str] = UNSET
    access_mode: Union[Unset, MountResponseAccessMode] = UNSET
    config: Union[Unset, "MountConfigResponse"] = UNSET
    connection_status: Union[Unset, MountResponseConnectionStatus] = UNSET
    auth_error: Union[Unset, str] = UNSET
    authorization_type: Union[Unset, MountResponseAuthorizationType] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        type_: Union[Unset, str] = UNSET
        if not isinstance(self.type_, Unset):
            type_ = self.type_.value

        path = self.path

        name = self.name

        access_mode: Union[Unset, str] = UNSET
        if not isinstance(self.access_mode, Unset):
            access_mode = self.access_mode.value

        config: Union[Unset, dict[str, Any]] = UNSET
        if not isinstance(self.config, Unset):
            config = self.config.to_dict()

        connection_status: Union[Unset, str] = UNSET
        if not isinstance(self.connection_status, Unset):
            connection_status = self.connection_status.value

        auth_error = self.auth_error

        authorization_type: Union[Unset, str] = UNSET
        if not isinstance(self.authorization_type, Unset):
            authorization_type = self.authorization_type.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if id is not UNSET:
            field_dict["id"] = id
        if type_ is not UNSET:
            field_dict["type"] = type_
        if path is not UNSET:
            field_dict["path"] = path
        if name is not UNSET:
            field_dict["name"] = name
        if access_mode is not UNSET:
            field_dict["accessMode"] = access_mode
        if config is not UNSET:
            field_dict["config"] = config
        if connection_status is not UNSET:
            field_dict["connectionStatus"] = connection_status
        if auth_error is not UNSET:
            field_dict["authError"] = auth_error
        if authorization_type is not UNSET:
            field_dict["authorizationType"] = authorization_type

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mount_config_response import MountConfigResponse

        d = dict(src_dict)
        id = d.pop("id", UNSET)

        _type_ = d.pop("type", UNSET)
        type_: Union[Unset, MountResponseType]
        if isinstance(_type_, Unset):
            type_ = UNSET
        else:
            type_ = MountResponseType(_type_)

        path = d.pop("path", UNSET)

        name = d.pop("name", UNSET)

        _access_mode = d.pop("accessMode", UNSET)
        access_mode: Union[Unset, MountResponseAccessMode]
        if isinstance(_access_mode, Unset):
            access_mode = UNSET
        else:
            access_mode = MountResponseAccessMode(_access_mode)

        _config = d.pop("config", UNSET)
        config: Union[Unset, MountConfigResponse]
        if isinstance(_config, Unset):
            config = UNSET
        else:
            config = MountConfigResponse.from_dict(_config)

        _connection_status = d.pop("connectionStatus", UNSET)
        connection_status: Union[Unset, MountResponseConnectionStatus]
        if isinstance(_connection_status, Unset):
            connection_status = UNSET
        else:
            connection_status = MountResponseConnectionStatus(_connection_status)

        auth_error = d.pop("authError", UNSET)

        _authorization_type = d.pop("authorizationType", UNSET)
        authorization_type: Union[Unset, MountResponseAuthorizationType]
        if isinstance(_authorization_type, Unset):
            authorization_type = UNSET
        else:
            authorization_type = MountResponseAuthorizationType(_authorization_type)

        mount_response = cls(
            id=id,
            type_=type_,
            path=path,
            name=name,
            access_mode=access_mode,
            config=config,
            connection_status=connection_status,
            auth_error=auth_error,
            authorization_type=authorization_type,
        )

        mount_response.additional_properties = d
        return mount_response

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
