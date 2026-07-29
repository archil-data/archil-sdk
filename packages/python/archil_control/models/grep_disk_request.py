from collections.abc import Mapping
from typing import Any, TypeVar, Union

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="GrepDiskRequest")


@_attrs_define
class GrepDiskRequest:
    """
    Attributes:
        directory (str): Directory on the disk to search, relative to the disk root.
            An empty string or "/" means the disk root.
             Example: data/logs.
        pattern (str): Extended regular expression (passed to `grep -E`) Example: ERROR|FATAL.
        recursive (Union[Unset, bool]): When true, walks subdirectories breadth-first. Default: False.
        max_duration_seconds (Union[Unset, int]): Wall-clock deadline for the entire request. Capped at 30
            seconds because the runtime exec container itself is bounded
            at ~30s; longer requests would have their workers killed
            mid-scan.
             Default: 30.
        concurrency (Union[Unset, int]): Maximum number of parallel grep workers. Higher values finish
            larger datasets within the deadline but consume proportionally
            more runtime capacity.
             Default: 50.
        max_results (Union[Unset, int]): Stop scanning once the aggregator has this many matches.
            Returned matches are a sample of whichever workers reported
            first, not the lexicographically first N.
             Default: 1000.
    """

    directory: str
    pattern: str
    recursive: Union[Unset, bool] = False
    max_duration_seconds: Union[Unset, int] = 30
    concurrency: Union[Unset, int] = 50
    max_results: Union[Unset, int] = 1000
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        directory = self.directory

        pattern = self.pattern

        recursive = self.recursive

        max_duration_seconds = self.max_duration_seconds

        concurrency = self.concurrency

        max_results = self.max_results

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "directory": directory,
                "pattern": pattern,
            }
        )
        if recursive is not UNSET:
            field_dict["recursive"] = recursive
        if max_duration_seconds is not UNSET:
            field_dict["maxDurationSeconds"] = max_duration_seconds
        if concurrency is not UNSET:
            field_dict["concurrency"] = concurrency
        if max_results is not UNSET:
            field_dict["maxResults"] = max_results

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        directory = d.pop("directory")

        pattern = d.pop("pattern")

        recursive = d.pop("recursive", UNSET)

        max_duration_seconds = d.pop("maxDurationSeconds", UNSET)

        concurrency = d.pop("concurrency", UNSET)

        max_results = d.pop("maxResults", UNSET)

        grep_disk_request = cls(
            directory=directory,
            pattern=pattern,
            recursive=recursive,
            max_duration_seconds=max_duration_seconds,
            concurrency=concurrency,
            max_results=max_results,
        )

        grep_disk_request.additional_properties = d
        return grep_disk_request

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
