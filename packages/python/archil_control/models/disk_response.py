import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..models.disk_response_status import DiskResponseStatus
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.authorized_user import AuthorizedUser
    from ..models.connected_client import ConnectedClient
    from ..models.disk_metrics import DiskMetrics
    from ..models.mount_response import MountResponse


T = TypeVar("T", bound="DiskResponse")


@_attrs_define
class DiskResponse:
    """
    Attributes:
        id (str): Disk ID Example: dsk-0123456789abcdef.
        name (str): Disk name
        organization (str): Owning organization ID
        status (DiskResponseStatus): Disk status
        provider (str): Cloud provider
        region (str): Disk region (e.g., aws-us-east-1, gcp-us-central1)
        created_at (datetime.datetime): Creation timestamp
        fs_handler_status (Union[Unset, str]): Filesystem handler status
        last_accessed (Union[Unset, datetime.datetime]): Last access timestamp
        data_size (Union[Unset, int]): Total data size in bytes
        monthly_usage (Union[Unset, str]): Monthly usage amount formatted as a currency string (e.g., "$1.23")
        mounts (Union[Unset, list['MountResponse']]):
        metrics (Union[Unset, DiskMetrics]):
        connected_clients (Union[Unset, list['ConnectedClient']]):
        authorized_users (Union[Unset, list['AuthorizedUser']]):
    """

    id: str
    name: str
    organization: str
    status: DiskResponseStatus
    provider: str
    region: str
    created_at: datetime.datetime
    fs_handler_status: Union[Unset, str] = UNSET
    last_accessed: Union[Unset, datetime.datetime] = UNSET
    data_size: Union[Unset, int] = UNSET
    monthly_usage: Union[Unset, str] = UNSET
    mounts: Union[Unset, list["MountResponse"]] = UNSET
    metrics: Union[Unset, "DiskMetrics"] = UNSET
    connected_clients: Union[Unset, list["ConnectedClient"]] = UNSET
    authorized_users: Union[Unset, list["AuthorizedUser"]] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        name = self.name

        organization = self.organization

        status = self.status.value

        provider = self.provider

        region = self.region

        created_at = self.created_at.isoformat()

        fs_handler_status = self.fs_handler_status

        last_accessed: Union[Unset, str] = UNSET
        if not isinstance(self.last_accessed, Unset):
            last_accessed = self.last_accessed.isoformat()

        data_size = self.data_size

        monthly_usage = self.monthly_usage

        mounts: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.mounts, Unset):
            mounts = []
            for mounts_item_data in self.mounts:
                mounts_item = mounts_item_data.to_dict()
                mounts.append(mounts_item)

        metrics: Union[Unset, dict[str, Any]] = UNSET
        if not isinstance(self.metrics, Unset):
            metrics = self.metrics.to_dict()

        connected_clients: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.connected_clients, Unset):
            connected_clients = []
            for connected_clients_item_data in self.connected_clients:
                connected_clients_item = connected_clients_item_data.to_dict()
                connected_clients.append(connected_clients_item)

        authorized_users: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.authorized_users, Unset):
            authorized_users = []
            for authorized_users_item_data in self.authorized_users:
                authorized_users_item = authorized_users_item_data.to_dict()
                authorized_users.append(authorized_users_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "name": name,
                "organization": organization,
                "status": status,
                "provider": provider,
                "region": region,
                "createdAt": created_at,
            }
        )
        if fs_handler_status is not UNSET:
            field_dict["fsHandlerStatus"] = fs_handler_status
        if last_accessed is not UNSET:
            field_dict["lastAccessed"] = last_accessed
        if data_size is not UNSET:
            field_dict["dataSize"] = data_size
        if monthly_usage is not UNSET:
            field_dict["monthlyUsage"] = monthly_usage
        if mounts is not UNSET:
            field_dict["mounts"] = mounts
        if metrics is not UNSET:
            field_dict["metrics"] = metrics
        if connected_clients is not UNSET:
            field_dict["connectedClients"] = connected_clients
        if authorized_users is not UNSET:
            field_dict["authorizedUsers"] = authorized_users

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.authorized_user import AuthorizedUser
        from ..models.connected_client import ConnectedClient
        from ..models.disk_metrics import DiskMetrics
        from ..models.mount_response import MountResponse

        d = dict(src_dict)
        id = d.pop("id")

        name = d.pop("name")

        organization = d.pop("organization")

        status = DiskResponseStatus(d.pop("status"))

        provider = d.pop("provider")

        region = d.pop("region")

        created_at = isoparse(d.pop("createdAt"))

        fs_handler_status = d.pop("fsHandlerStatus", UNSET)

        _last_accessed = d.pop("lastAccessed", UNSET)
        last_accessed: Union[Unset, datetime.datetime]
        if isinstance(_last_accessed, Unset):
            last_accessed = UNSET
        else:
            last_accessed = isoparse(_last_accessed)

        data_size = d.pop("dataSize", UNSET)

        monthly_usage = d.pop("monthlyUsage", UNSET)

        mounts = []
        _mounts = d.pop("mounts", UNSET)
        for mounts_item_data in _mounts or []:
            mounts_item = MountResponse.from_dict(mounts_item_data)

            mounts.append(mounts_item)

        _metrics = d.pop("metrics", UNSET)
        metrics: Union[Unset, DiskMetrics]
        if isinstance(_metrics, Unset):
            metrics = UNSET
        else:
            metrics = DiskMetrics.from_dict(_metrics)

        connected_clients = []
        _connected_clients = d.pop("connectedClients", UNSET)
        for connected_clients_item_data in _connected_clients or []:
            connected_clients_item = ConnectedClient.from_dict(connected_clients_item_data)

            connected_clients.append(connected_clients_item)

        authorized_users = []
        _authorized_users = d.pop("authorizedUsers", UNSET)
        for authorized_users_item_data in _authorized_users or []:
            authorized_users_item = AuthorizedUser.from_dict(authorized_users_item_data)

            authorized_users.append(authorized_users_item)

        disk_response = cls(
            id=id,
            name=name,
            organization=organization,
            status=status,
            provider=provider,
            region=region,
            created_at=created_at,
            fs_handler_status=fs_handler_status,
            last_accessed=last_accessed,
            data_size=data_size,
            monthly_usage=monthly_usage,
            mounts=mounts,
            metrics=metrics,
            connected_clients=connected_clients,
            authorized_users=authorized_users,
        )

        disk_response.additional_properties = d
        return disk_response

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
