import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar
from uuid import UUID

from attrs import define as _attrs_define
from attrs import field as _attrs_field
from dateutil.parser import isoparse

from ..models.activity_event_level import ActivityEventLevel

if TYPE_CHECKING:
    from ..models.activity_event_details import ActivityEventDetails


T = TypeVar("T", bound="ActivityEvent")


@_attrs_define
class ActivityEvent:
    """
    Attributes:
        account_id (str):
        event_id (UUID): Unique, time-ordered event id.
        disk_id (str):  Example: dsk-0123456789abcdef.
        event_type (str):  Example: disk.created.
        level (ActivityEventLevel): Event severity. Example: error.
        created_at (datetime.datetime):
        details (ActivityEventDetails): Event-specific attributes (e.g. diskName on disk.created; containerId, outcome,
            exitCode, failureClass on disk.exec).
    """

    account_id: str
    event_id: UUID
    disk_id: str
    event_type: str
    level: ActivityEventLevel
    created_at: datetime.datetime
    details: "ActivityEventDetails"
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        account_id = self.account_id

        event_id = str(self.event_id)

        disk_id = self.disk_id

        event_type = self.event_type

        level = self.level.value

        created_at = self.created_at.isoformat()

        details = self.details.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "accountId": account_id,
                "eventId": event_id,
                "diskId": disk_id,
                "eventType": event_type,
                "level": level,
                "createdAt": created_at,
                "details": details,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.activity_event_details import ActivityEventDetails

        d = dict(src_dict)
        account_id = d.pop("accountId")

        event_id = UUID(d.pop("eventId"))

        disk_id = d.pop("diskId")

        event_type = d.pop("eventType")

        level = ActivityEventLevel(d.pop("level"))

        created_at = isoparse(d.pop("createdAt"))

        details = ActivityEventDetails.from_dict(d.pop("details"))

        activity_event = cls(
            account_id=account_id,
            event_id=event_id,
            disk_id=disk_id,
            event_type=event_type,
            level=level,
            created_at=created_at,
            details=details,
        )

        activity_event.additional_properties = d
        return activity_event

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
