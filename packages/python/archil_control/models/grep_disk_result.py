from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.grep_stopped_reason import GrepStoppedReason

if TYPE_CHECKING:
    from ..models.grep_match import GrepMatch


T = TypeVar("T", bound="GrepDiskResult")


@_attrs_define
class GrepDiskResult:
    """
    Attributes:
        matches (list['GrepMatch']):
        stopped_reason (GrepStoppedReason): Why the search stopped.
            - `completed`: every file under the directory was scanned successfully.
            - `incomplete`: pipeline ran to its natural end but one or more
              batches errored (invalid regex, unreadable file, runtime issue).
              Results may be partial or wrong; do not rely on completeness.
            - `max_results`: hit `maxResults` before scanning everything.
            - `deadline`: hit `maxDurationSeconds`.
            - `list_failed`: directory listing failed; partial results
              may be present.
        files_scanned (int): Files actually fed to a grep container.
        containers_dispatched (int): Number of grep containers started for this request.
        compute_seconds_used (float): Sum of per-container execution time in seconds, measured by the
            runtime. Approximates billable container-seconds.
        duration_ms (int): End-to-end wall clock measured by the server.
        listing_ms (int): Wall-clock time spent enumerating files via listObjects, from
            the request's start to the moment listing fully drained (or
            was canceled). Listing and matching overlap, so listingMs +
            grepMs typically exceeds durationMs.
        grep_ms (int): Wall-clock time spent matching, from the first grep container
            being dispatched to the last container reporting results. 0 if
            no batches ran.
    """

    matches: list["GrepMatch"]
    stopped_reason: GrepStoppedReason
    files_scanned: int
    containers_dispatched: int
    compute_seconds_used: float
    duration_ms: int
    listing_ms: int
    grep_ms: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        matches = []
        for matches_item_data in self.matches:
            matches_item = matches_item_data.to_dict()
            matches.append(matches_item)

        stopped_reason = self.stopped_reason.value

        files_scanned = self.files_scanned

        containers_dispatched = self.containers_dispatched

        compute_seconds_used = self.compute_seconds_used

        duration_ms = self.duration_ms

        listing_ms = self.listing_ms

        grep_ms = self.grep_ms

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "matches": matches,
                "stoppedReason": stopped_reason,
                "filesScanned": files_scanned,
                "containersDispatched": containers_dispatched,
                "computeSecondsUsed": compute_seconds_used,
                "durationMs": duration_ms,
                "listingMs": listing_ms,
                "grepMs": grep_ms,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.grep_match import GrepMatch

        d = dict(src_dict)
        matches = []
        _matches = d.pop("matches")
        for matches_item_data in _matches:
            matches_item = GrepMatch.from_dict(matches_item_data)

            matches.append(matches_item)

        stopped_reason = GrepStoppedReason(d.pop("stoppedReason"))

        files_scanned = d.pop("filesScanned")

        containers_dispatched = d.pop("containersDispatched")

        compute_seconds_used = d.pop("computeSecondsUsed")

        duration_ms = d.pop("durationMs")

        listing_ms = d.pop("listingMs")

        grep_ms = d.pop("grepMs")

        grep_disk_result = cls(
            matches=matches,
            stopped_reason=stopped_reason,
            files_scanned=files_scanned,
            containers_dispatched=containers_dispatched,
            compute_seconds_used=compute_seconds_used,
            duration_ms=duration_ms,
            listing_ms=listing_ms,
            grep_ms=grep_ms,
        )

        grep_disk_result.additional_properties = d
        return grep_disk_result

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
