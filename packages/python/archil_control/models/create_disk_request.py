from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, Union, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.aws_sts_user import AwsStsUser
    from ..models.azure_blob_storage import AzureBlobStorage
    from ..models.cloudflare_r2 import CloudflareR2
    from ..models.google_cloud_storage import GoogleCloudStorage
    from ..models.s3 import S3
    from ..models.s3_compatible import S3Compatible
    from ..models.token_user import TokenUser


T = TypeVar("T", bound="CreateDiskRequest")


@_attrs_define
class CreateDiskRequest:
    """
    Attributes:
        name (str): Disk name (alphanumeric, dashes, underscores) Example: my-data-disk.
        mounts (Union[Unset, list[Union['AzureBlobStorage', 'CloudflareR2', 'GoogleCloudStorage', 'S3',
            'S3Compatible']]]): Storage mount to attach. Omit for archil-managed storage.
        allowed_ips (Union[Unset, list[str]]): IP allowlist for mount access. When non-empty, only clients connecting
            from these IPs or CIDR ranges can mount the disk. An empty list (default) allows all IPs.
             Example: ['203.0.113.0/24', '198.51.100.42'].
        auth_methods (Union[Unset, list[Union['AwsStsUser', 'TokenUser']]]): Deprecated. Use AddDiskUser after creation
            instead. When provided, suppresses the default auto-generated token user.
    """

    name: str
    mounts: Union[
        Unset, list[Union["AzureBlobStorage", "CloudflareR2", "GoogleCloudStorage", "S3", "S3Compatible"]]
    ] = UNSET
    allowed_ips: Union[Unset, list[str]] = UNSET
    auth_methods: Union[Unset, list[Union["AwsStsUser", "TokenUser"]]] = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.cloudflare_r2 import CloudflareR2
        from ..models.google_cloud_storage import GoogleCloudStorage
        from ..models.s3 import S3
        from ..models.s3_compatible import S3Compatible
        from ..models.token_user import TokenUser

        name = self.name

        mounts: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.mounts, Unset):
            mounts = []
            for mounts_item_data in self.mounts:
                mounts_item: dict[str, Any]
                if isinstance(mounts_item_data, S3):
                    mounts_item = mounts_item_data.to_dict()
                elif isinstance(mounts_item_data, GoogleCloudStorage):
                    mounts_item = mounts_item_data.to_dict()
                elif isinstance(mounts_item_data, CloudflareR2):
                    mounts_item = mounts_item_data.to_dict()
                elif isinstance(mounts_item_data, S3Compatible):
                    mounts_item = mounts_item_data.to_dict()
                else:
                    mounts_item = mounts_item_data.to_dict()

                mounts.append(mounts_item)

        allowed_ips: Union[Unset, list[str]] = UNSET
        if not isinstance(self.allowed_ips, Unset):
            allowed_ips = self.allowed_ips

        auth_methods: Union[Unset, list[dict[str, Any]]] = UNSET
        if not isinstance(self.auth_methods, Unset):
            auth_methods = []
            for auth_methods_item_data in self.auth_methods:
                auth_methods_item: dict[str, Any]
                if isinstance(auth_methods_item_data, TokenUser):
                    auth_methods_item = auth_methods_item_data.to_dict()
                else:
                    auth_methods_item = auth_methods_item_data.to_dict()

                auth_methods.append(auth_methods_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "name": name,
            }
        )
        if mounts is not UNSET:
            field_dict["mounts"] = mounts
        if allowed_ips is not UNSET:
            field_dict["allowedIps"] = allowed_ips
        if auth_methods is not UNSET:
            field_dict["authMethods"] = auth_methods

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.aws_sts_user import AwsStsUser
        from ..models.azure_blob_storage import AzureBlobStorage
        from ..models.cloudflare_r2 import CloudflareR2
        from ..models.google_cloud_storage import GoogleCloudStorage
        from ..models.s3 import S3
        from ..models.s3_compatible import S3Compatible
        from ..models.token_user import TokenUser

        d = dict(src_dict)
        name = d.pop("name")

        mounts = []
        _mounts = d.pop("mounts", UNSET)
        for mounts_item_data in _mounts or []:

            def _parse_mounts_item(
                data: object,
            ) -> Union["AzureBlobStorage", "CloudflareR2", "GoogleCloudStorage", "S3", "S3Compatible"]:
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    componentsschemas_mount_config_type_0 = S3.from_dict(data)

                    return componentsschemas_mount_config_type_0
                except:  # noqa: E722
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    componentsschemas_mount_config_type_1 = GoogleCloudStorage.from_dict(data)

                    return componentsschemas_mount_config_type_1
                except:  # noqa: E722
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    componentsschemas_mount_config_type_2 = CloudflareR2.from_dict(data)

                    return componentsschemas_mount_config_type_2
                except:  # noqa: E722
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    componentsschemas_mount_config_type_3 = S3Compatible.from_dict(data)

                    return componentsschemas_mount_config_type_3
                except:  # noqa: E722
                    pass
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_mount_config_type_4 = AzureBlobStorage.from_dict(data)

                return componentsschemas_mount_config_type_4

            mounts_item = _parse_mounts_item(mounts_item_data)

            mounts.append(mounts_item)

        allowed_ips = cast(list[str], d.pop("allowedIps", UNSET))

        auth_methods = []
        _auth_methods = d.pop("authMethods", UNSET)
        for auth_methods_item_data in _auth_methods or []:

            def _parse_auth_methods_item(data: object) -> Union["AwsStsUser", "TokenUser"]:
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    componentsschemas_disk_user_type_0 = TokenUser.from_dict(data)

                    return componentsschemas_disk_user_type_0
                except:  # noqa: E722
                    pass
                if not isinstance(data, dict):
                    raise TypeError()
                componentsschemas_disk_user_type_1 = AwsStsUser.from_dict(data)

                return componentsschemas_disk_user_type_1

            auth_methods_item = _parse_auth_methods_item(auth_methods_item_data)

            auth_methods.append(auth_methods_item)

        create_disk_request = cls(
            name=name,
            mounts=mounts,
            allowed_ips=allowed_ips,
            auth_methods=auth_methods,
        )

        create_disk_request.additional_properties = d
        return create_disk_request

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
