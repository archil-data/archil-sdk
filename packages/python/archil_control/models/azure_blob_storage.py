from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.azure_blob_storage_type import AzureBlobStorageType
from ..types import UNSET, Unset

T = TypeVar("T", bound="AzureBlobStorage")


@_attrs_define
class AzureBlobStorage:
    """Mount configuration for Azure Blob Storage containers

    Attributes:
        type_ (AzureBlobStorageType): Mount type identifier
        container_name (str): Azure blob container name Example: my-container.
        tenant_id (str): Azure AD tenant ID
        client_id (str): Azure AD application client ID
        client_secret (str): Azure AD application client secret
        endpoint (Union[Unset, str]): Azure blob endpoint URL (optional if storageAccountName provided) Example:
            https://myaccount.blob.core.windows.net.
        storage_account_name (Union[Unset, str]): Azure storage account name (used to derive endpoint if not provided)
            Example: myaccount.
        bucket_prefix (Union[Unset, str]): Prefix within the container Example: data/.
    """

    type_: AzureBlobStorageType
    container_name: str
    tenant_id: str
    client_id: str
    client_secret: str
    endpoint: Union[Unset, str] = UNSET
    storage_account_name: Union[Unset, str] = UNSET
    bucket_prefix: Union[Unset, str] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_.value

        container_name = self.container_name

        tenant_id = self.tenant_id

        client_id = self.client_id

        client_secret = self.client_secret

        endpoint = self.endpoint

        storage_account_name = self.storage_account_name

        bucket_prefix = self.bucket_prefix

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "containerName": container_name,
                "tenantId": tenant_id,
                "clientId": client_id,
                "clientSecret": client_secret,
            }
        )
        if endpoint is not UNSET:
            field_dict["endpoint"] = endpoint
        if storage_account_name is not UNSET:
            field_dict["storageAccountName"] = storage_account_name
        if bucket_prefix is not UNSET:
            field_dict["bucketPrefix"] = bucket_prefix

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = AzureBlobStorageType(d.pop("type"))

        container_name = d.pop("containerName")

        tenant_id = d.pop("tenantId")

        client_id = d.pop("clientId")

        client_secret = d.pop("clientSecret")

        endpoint = d.pop("endpoint", UNSET)

        storage_account_name = d.pop("storageAccountName", UNSET)

        bucket_prefix = d.pop("bucketPrefix", UNSET)

        azure_blob_storage = cls(
            type_=type_,
            container_name=container_name,
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret,
            endpoint=endpoint,
            storage_account_name=storage_account_name,
            bucket_prefix=bucket_prefix,
        )

        azure_blob_storage.additional_properties = d
        return azure_blob_storage

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
