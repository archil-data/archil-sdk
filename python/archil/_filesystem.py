"""The filesystem contract shared by :class:`Disk` and :class:`Workspace`.

It is the object API a :class:`Disk` already exposes — ``get_object``,
``put_object``, ``delete_object``, ``list_objects``, ``grep``, ``exec`` —
captured as a ``Protocol`` so a multi-disk :class:`Workspace` can be used
anywhere a single disk is. A single disk's keys are relative to the disk root; a
workspace's keys carry the mounted-disk name as their first segment (e.g.
``data/reports/q1.csv``), and ``list_objects`` / ``grep`` fan out across every
disk when the key/prefix doesn't name one.

``test_filesystem`` asserts (via ``@runtime_checkable``) that both still satisfy
this, so dropping or renaming a method on one without the other fails the suite.
"""

from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from ._http import BodyType
from ._models import ExecResult, GrepResult, ListObjectsResult, PutObjectResult


@runtime_checkable
class FileSystem(Protocol):
    """A key-addressable filesystem over one or more Archil disks. Every method
    is available synchronously (blocking) and via ``.aio`` for a coroutine, like
    the rest of the SDK."""

    def get_object(self, key: str) -> bytes:
        """Read an object's full contents. Raises ``ArchilS3Error`` (404) if absent."""
        ...

    def put_object(
        self,
        key: str,
        body: BodyType,
        content_type: Optional[str] = None,
        *,
        mode: Optional[int] = None,
        uid: Optional[int] = None,
        gid: Optional[int] = None,
    ) -> PutObjectResult:
        """Create or overwrite an object. Optional ``mode``/``uid``/``gid`` set
        POSIX attributes on the published leaf and ownership on missing parent
        directories; existing directories are unchanged."""
        ...

    def delete_object(self, key: str) -> None:
        """Delete an object (idempotent)."""
        ...

    def list_objects(self, prefix: Optional[str] = None, *, recursive: bool = False) -> ListObjectsResult:
        """List objects and common (directory) prefixes under a key prefix."""
        ...

    def grep(
        self,
        *,
        directory: str,
        pattern: str,
        recursive: bool = False,
        max_duration_seconds: int = 30,
        concurrency: int = 50,
        max_results: int = 1000,
    ) -> GrepResult:
        """Constant-time parallel grep."""
        ...

    def exec(self, command: str) -> ExecResult:
        """Run a command in a sandbox with the filesystem mounted."""
        ...
