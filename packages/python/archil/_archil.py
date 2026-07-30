from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional, Union

from ._disks import _Disks
from ._http import _Transport
from ._models import ExecResult
from ._regions import derive_s3_base_url, resolve_base_url
from ._tokens import _Tokens

# Imported at runtime (not under TYPE_CHECKING) so the synchronicity stub
# generator can resolve workspace()'s return type. _workspace imports _archil
# only lazily (inside methods), so this does not create an import cycle.
from ._workspace import _Workspace


@dataclass
class ExecMountSpec:
    """One disk to mount in an exec request, with optional subdirectory pinning,
    a read-only flag, and a conditional-mode flag. For the default case (mount
    the disk's root, read-write), pass a ``Disk`` or disk-id string directly
    instead.

    ``conditional`` mounts the disk in conditional mode, where mutating
    operations are sent directly to the server without a delegation checkout.
    This enables concurrent writes from multiple clients to the same disk."""

    disk: object  # a Disk (wrapped or impl) or a disk-id string
    subdirectory: Optional[str] = None
    read_only: bool = False
    conditional: bool = False


# A Disk instance, a disk-id string, or an ExecMountSpec.
ExecMount = Union[object, str, ExecMountSpec]


def _disk_id(mount: object) -> str:
    if isinstance(mount, str):
        return mount
    # Both the wrapped Disk and the impl _Disk expose `.id`.
    return mount.id  # type: ignore[attr-defined]


class _Archil:
    """Top-level Archil client. Holds the account-level ``disks`` and ``tokens``
    collections and the cross-disk ``exec``. Construct directly for multi-account
    or multi-region scripts; otherwise use the module-level helpers.

    Every method is available both synchronously and asynchronously: call it
    directly to block, or use the ``.aio`` attribute for a coroutine
    (e.g. ``await archil.exec.aio(...)``). Also usable as an (async) context
    manager: ``with Archil(...) as a:`` / ``async with Archil(...) as a:``."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        region: Optional[str] = None,
        base_url: Optional[str] = None,
        s3_base_url: Optional[str] = None,
        timeout: Optional[float] = 30.0,
        _http_transport=None,
    ) -> None:
        api_key = api_key or os.environ.get("ARCHIL_API_KEY")
        region = region or os.environ.get("ARCHIL_REGION")
        if not api_key:
            raise ValueError(
                "Missing API key: pass api_key or set the ARCHIL_API_KEY environment variable"
            )
        if not region:
            raise ValueError(
                "Missing region: pass region or set the ARCHIL_REGION environment variable"
            )

        # Resolve the control-plane URL the same way the transport would (explicit
        # override, else region lookup) so the S3 endpoint can be derived from it
        # even on the common region-based path.
        control_base_url = base_url or resolve_base_url(region)
        s3 = s3_base_url or os.environ.get("ARCHIL_S3_BASE_URL") or derive_s3_base_url(control_base_url)

        self._transport = _Transport(
            control_base_url, api_key, s3, transport=_http_transport, timeout=timeout
        )
        self._disks = _Disks(self._transport, region)
        self._tokens = _Tokens(self._transport)

    @property
    def disks(self) -> "_Disks":
        return self._disks

    @property
    def tokens(self) -> "_Tokens":
        return self._tokens

    async def exec(self, *, disks: dict[str, ExecMount], command: str) -> ExecResult:
        """Run a command in a container with multiple disks mounted
        simultaneously, each at its own relative path under ``/mnt/archil``.
        Blocks until the command completes and returns its stdout, stderr, exit
        code, and timing."""
        payload: dict[str, object] = {}
        for rel_path, mount in disks.items():
            if isinstance(mount, ExecMountSpec):
                entry: dict[str, object] = {
                    "disk": _disk_id(mount.disk),
                    "readOnly": mount.read_only,
                    "conditional": mount.conditional,
                }
                if mount.subdirectory is not None:
                    entry["subdirectory"] = mount.subdirectory
                payload[rel_path] = entry
            else:
                payload[rel_path] = _disk_id(mount)
        data = await self._transport.request_json(
            "POST",
            "/api/exec",
            json={"disks": payload, "command": command},
            timeout=None,
        )
        return ExecResult.from_json(data)

    def workspace(self, mounts: dict[str, ExecMount]) -> "_Workspace":
        """Build a :class:`Workspace`: a filesystem spanning several disks at once.

        ``mounts`` maps a relative path to a disk (or ``ExecMountSpec``), exactly
        like :meth:`exec`; each disk appears as a top-level directory. The
        workspace is a full filesystem — ``read_file`` / ``write_file`` /
        ``list_files`` / ``grep`` / ``exec`` route to the right disk by path, and
        ``grep`` / ``list_files`` fan out across all of them — and
        ``agent_tools()`` builds drop-in agent tools just like :meth:`Disk`::

            ws = archil.workspace({"data": disk_a, "cache": disk_b})
            agent = Agent(tools=ws.agent_tools().for_langchain())
        """
        return _Workspace(self, mounts)

    async def close(self) -> None:
        """Close the underlying HTTP connections. Optional — also usable as a
        context manager (``with Archil(...) as archil:``)."""
        await self._transport.aclose()

    async def __aenter__(self) -> "_Archil":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._transport.aclose()
