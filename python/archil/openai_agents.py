"""Mount an Archil disk inside an OpenAI Agents SDK sandbox.

``ArchilMount`` runs the ``archil`` client inside a live sandbox session, so the
agent's shell and file tools see the disk as a regular directory::

    from archil.openai_agents import ArchilMount

    session = await client.create(manifest=agent.default_manifest)
    async with session:
        await ArchilMount(disk="dsk-...", token=token, path="data").attach(session)
        await Runner.run(agent, "...", run_config=RunConfig(sandbox=SandboxRunConfig(session=session)))

The disk is released when the session closes. ``ArchilMount`` is not a manifest
``Mount`` entry: since openai-agents 0.20 the SDK rejects mount classes it does
not ship at its credential boundary, so the disk is attached to the session
after it starts instead.
"""

from __future__ import annotations

import io
import json
import os
import shlex
import uuid
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agents.sandbox.session.base_sandbox_session import BaseSandboxSession

INSTALL_COMMAND = (
    "command -v archil >/dev/null 2>&1 || {"
    " if command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null; fi;"
    " curl -fsSL https://archil.com/install | sh >/dev/null; }"
)


class ArchilMountError(RuntimeError):
    """A command ``ArchilMount`` ran inside the sandbox failed."""


@dataclass
class ArchilMount:
    """An Archil disk to mount in a sandbox session.

    ``path`` is relative to the workspace root unless it is absolute. ``token``
    is the disk's mount token and defaults to ``ARCHIL_MOUNT_TOKEN``; ``region``
    defaults to ``ARCHIL_REGION``. ``user`` is the sandbox user that runs the
    ``archil`` client, which needs root.

    By default the mount is exclusive: one client holds the disk at a time.
    ``shared`` lets several clients mount it, read-only until a client runs
    ``archil checkout`` on a path. ``conditional`` lets several clients write
    without a checkout: each writes any path no other client has checked out,
    and the last write wins. ``read_only`` combines with either.

    With ``make_writable``, a writable, non-shared mount whose root directory
    the session's default user cannot write to is handed to that user, so the
    agent can write to the disk.
    """

    disk: str
    path: str = "archil"
    token: str | None = field(default=None, repr=False)
    region: str | None = None
    read_only: bool = False
    shared: bool = False
    conditional: bool = False
    install_client: bool = True
    make_writable: bool = True
    user: str | None = "root"
    _mounted: dict[int, str] = field(default_factory=dict, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if self.shared and self.conditional:
            raise ValueError("shared and conditional are mutually exclusive; pick one")

    async def attach(self, session: BaseSandboxSession) -> str:
        """Mount the disk in a started session and return the mount path.

        Registers a pre-stop hook that releases the disk when the session
        closes, and keeps the mount out of workspace snapshots."""
        token = self.token or os.environ.get("ARCHIL_MOUNT_TOKEN")
        region = self.region or os.environ.get("ARCHIL_REGION")
        if not token:
            raise ValueError("Missing mount token: pass token or set ARCHIL_MOUNT_TOKEN")
        if not region:
            raise ValueError("Missing region: pass region or set ARCHIL_REGION")
        if id(session) in self._mounted:
            raise ValueError(f"{self.disk} is already attached to this session")

        mount_path = self._mount_path(session)
        root = PurePosixPath(session.state.manifest.root)
        if mount_path.is_relative_to(root):
            session.register_persist_workspace_skip_path(mount_path.relative_to(root).as_posix())

        if self.install_client:
            await self._run(session, INSTALL_COMMAND, "install the archil client", timeout=300)

        # The token goes through a file, not the command line: session.exec
        # records commands in SDK audit events and traces.
        token_file = root / f".archil-mount-token-{uuid.uuid4().hex[:8]}"
        session.register_persist_workspace_skip_path(token_file.name)
        await session.write(Path(token_file), io.BytesIO(token.encode()))
        quoted_token_file = shlex.quote(token_file.as_posix())
        try:
            await self._run(
                session,
                f'ARCHIL_MOUNT_TOKEN="$(cat {quoted_token_file})"; rm -f {quoted_token_file};'
                f" export ARCHIL_MOUNT_TOKEN; {self._mount_command(mount_path, region)}",
                f"mount {self.disk}",
                timeout=120,
            )
            self._mounted[id(session)] = mount_path.as_posix()
            session.register_pre_stop_hook(lambda: self.detach(session))
        finally:
            await session.exec(f"rm -f {quoted_token_file}", timeout=30, user=self.user)

        if self.make_writable and not self.read_only and not self.shared:
            await self._make_writable(session, mount_path)
        return mount_path.as_posix()

    async def detach(self, session: BaseSandboxSession) -> None:
        """Flush buffered writes and release the disk.

        Safe to call more than once; after a failure, calling it again retries."""
        mount_path = self._mounted.get(id(session))
        if mount_path is None:
            return
        await self._release(session, shlex.quote(mount_path))
        del self._mounted[id(session)]

    async def _release(self, session: BaseSandboxSession, path: str) -> None:
        unmount = await session.exec(f"archil unmount {path}", timeout=300, user=self.user)
        if unmount.exit_code == 0 or self.read_only:
            return
        # Some runtimes (Daytona) refuse to detach a FUSE mount. Flushing and
        # checking in every delegation releases the disk the same way.
        await self._run(session, f"archil sync {path}", f"flush {self.disk}", timeout=300)
        listing = await self._run(
            session, f"archil delegations {path} --json", f"list {self.disk} delegations", timeout=60
        )
        held = sorted((d["path"] for d in json.loads(listing)), key=lambda p: -p.count("/"))
        for delegation in held:
            await self._run(session, f"archil checkin {shlex.quote(delegation)}", f"release {self.disk}", timeout=60)

    def _mount_path(self, session: BaseSandboxSession) -> PurePosixPath:
        path = PurePosixPath(self.path)
        if ".." in path.parts:
            raise ValueError(f"Mount path must not contain '..': {self.path}")
        root = PurePosixPath(session.state.manifest.root)
        mount_path = path if path.is_absolute() else root / path
        if mount_path == root:
            raise ValueError("Mount path must not be the workspace root")
        return mount_path

    def _mount_command(self, mount_path: PurePosixPath, region: str) -> str:
        args = ["archil", "mount", self.disk, mount_path.as_posix(), "--region", region]
        if self.shared:
            args.append("--shared")
        if self.conditional:
            args.append("--conditional")
        if self.read_only:
            args.append("--read-only")
        return f"mkdir -p {shlex.quote(mount_path.as_posix())} && {shlex.join(args)}"

    async def _make_writable(self, session: BaseSandboxSession, mount_path: PurePosixPath) -> None:
        path = shlex.quote(mount_path.as_posix())
        probe = await session.exec(f'test -w {path} || echo "$(id -u):$(id -g)"', timeout=30)
        owner = probe.stdout.decode().strip()
        if probe.exit_code != 0 or not owner:
            return
        await self._run(session, f"chown {shlex.quote(owner)} {path}", "make the disk writable", timeout=30)

    async def _run(self, session: BaseSandboxSession, command: str, action: str, *, timeout: float) -> bytes:
        result = await session.exec(command, timeout=timeout, user=self.user)
        if result.exit_code != 0:
            detail = (result.stderr or result.stdout).decode(errors="replace").strip()
            raise ArchilMountError(f"Failed to {action} (exit {result.exit_code}): {detail}")
        return result.stdout
