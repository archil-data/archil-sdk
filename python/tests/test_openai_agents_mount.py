"""ArchilMount against real OpenAI Agents SDK sandbox sessions.

Each test runs a real ``UnixLocalSandboxClient`` session, so the SDK's own exec,
write, pre-stop hook, snapshot, and audit-event machinery is exercised. Only the
``archil`` client is replaced, by a script on ``PATH`` that records its calls.
"""

from __future__ import annotations

import io
import os
import sys
import tarfile
from pathlib import Path

import pytest

pytest.importorskip("agents.sandbox")
if sys.platform == "win32":  # pragma: no cover
    pytest.skip("unix_local sandboxes need a POSIX shell", allow_module_level=True)

from agents.sandbox import Manifest  # noqa: E402
from agents.sandbox.sandboxes.unix_local import UnixLocalSandboxClient  # noqa: E402
from agents.sandbox.session.events import EventPayloadPolicy  # noqa: E402
from agents.sandbox.session.manager import Instrumentation  # noqa: E402
from agents.sandbox.session.sinks import CallbackSink  # noqa: E402

from archil.openai_agents import ArchilMount, ArchilMountError  # noqa: E402

TOKEN = "disk-token-secret-123"

FAKE_ARCHIL = r"""#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_ARCHIL_LOG"
case "$1" in
  mount)
    [ -n "$FAKE_MOUNT_FAILS" ] && { echo "mount refused" >&2; exit 1; }
    echo "token=$ARCHIL_MOUNT_TOKEN" >> "$FAKE_ARCHIL_LOG"
    echo "disk contents" > "$3/on-disk.txt"
    [ -n "$FAKE_ROOT_NOT_WRITABLE" ] && chmod 555 "$3"
    exit 0 ;;
  unmount)
    [ -n "$FAKE_UNMOUNT_FAILS" ] && { echo "cannot detach" >&2; exit 1; }
    exit 0 ;;
  delegations)
    printf '[{"path": "%s", "state": "Held"}, {"path": "%s/sub/dir", "state": "Held"}]\n' "$2" "$2" ;;
esac
exit 0
"""

FAKE_CHOWN = r"""#!/bin/sh
printf 'chown %s\n' "$*" >> "$FAKE_ARCHIL_LOG"
"""


@pytest.fixture
def fake_archil(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, script in (("archil", FAKE_ARCHIL), ("chown", FAKE_CHOWN)):
        (bin_dir / name).write_text(script)
        (bin_dir / name).chmod(0o755)
    # Inside the workspace: on macOS, unix_local sessions may only write there.
    log = tmp_path / "workspace" / ".archil-calls.log"
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_ARCHIL_LOG", str(log))
    monkeypatch.delenv("ARCHIL_MOUNT_TOKEN", raising=False)
    monkeypatch.delenv("ARCHIL_REGION", raising=False)
    return lambda: log.read_text().splitlines() if log.exists() else []


@pytest.fixture
def events():
    return []


@pytest.fixture
async def session(tmp_path, events):
    sink = CallbackSink(lambda event, _session: events.append(event.model_dump_json()))
    instrumentation = Instrumentation(sinks=[sink], payload_policy=EventPayloadPolicy(include_exec_output=True))
    workspace = tmp_path / "workspace"
    session = await UnixLocalSandboxClient(instrumentation=instrumentation).create(
        manifest=Manifest(root=str(workspace))
    )
    await session.start()
    yield session
    await session.aclose()


def local_mount(**kwargs) -> ArchilMount:
    defaults = dict(disk="dsk-123", token=TOKEN, region="aws-us-east-1", user=None, install_client=False)
    return ArchilMount(**(defaults | kwargs))


@pytest.mark.parametrize(
    ("options", "flags"),
    [
        ({}, "--region aws-us-east-1"),
        ({"shared": True}, "--region aws-us-east-1 --shared"),
        ({"read_only": True}, "--region aws-us-east-1 --read-only"),
        ({"conditional": True}, "--region aws-us-east-1 --conditional"),
        ({"shared": True, "read_only": True}, "--region aws-us-east-1 --shared --read-only"),
        ({"conditional": True, "read_only": True}, "--region aws-us-east-1 --conditional --read-only"),
    ],
)
async def test_attach_runs_archil_mount_with_cli_flags(fake_archil, session, options, flags):
    mount_path = await local_mount(path="data", **options).attach(session)

    root = Path(session.state.manifest.root)
    assert mount_path == (root / "data").as_posix()
    assert f"mount dsk-123 {mount_path} {flags}" in fake_archil()
    assert (root / "data" / "on-disk.txt").read_text() == "disk contents\n"


async def test_absolute_path_is_used_as_is(fake_archil, session):
    target = Path(session.state.manifest.root) / "nested" / "disk"
    assert await local_mount(path=str(target)).attach(session) == target.as_posix()
    assert (target / "on-disk.txt").exists()


async def test_token_reaches_the_client_but_not_audit_events_or_the_workspace(fake_archil, session, events):
    await local_mount(path="data").attach(session)

    assert f"token={TOKEN}" in fake_archil()
    assert events and not any(TOKEN in event for event in events)
    root = Path(session.state.manifest.root)
    assert not list(root.glob(".archil-mount-token-*"))


async def test_token_and_region_default_to_environment(fake_archil, session, monkeypatch):
    monkeypatch.setenv("ARCHIL_MOUNT_TOKEN", "from-env")
    monkeypatch.setenv("ARCHIL_REGION", "aws-eu-west-1")

    mount_path = await local_mount(token=None, region=None, path="data").attach(session)

    assert f"mount dsk-123 {mount_path} --region aws-eu-west-1" in fake_archil()
    assert "token=from-env" in fake_archil()


async def test_mount_is_left_out_of_workspace_snapshots(fake_archil, session):
    root = Path(session.state.manifest.root)
    (root / "notes.txt").write_text("workspace file")
    await local_mount(path="data").attach(session)

    archive = await session.persist_workspace()
    with tarfile.open(fileobj=io.BytesIO(archive.read())) as tar:
        names = tar.getnames()

    assert any(name.endswith("notes.txt") for name in names)
    assert not any("data" in name.split("/") for name in names)


async def test_closing_the_session_unmounts_the_disk(fake_archil, tmp_path, session):
    mount_path = await local_mount(path="data").attach(session)
    assert f"unmount {mount_path}" not in fake_archil()

    await session.aclose()

    assert f"unmount {mount_path}" in fake_archil()


async def test_detach_is_idempotent(fake_archil, session):
    mount = local_mount(path="data")
    mount_path = await mount.attach(session)

    await mount.detach(session)
    await session.aclose()

    assert fake_archil().count(f"unmount {mount_path}") == 1


async def test_detach_falls_back_to_sync_and_checkin_when_unmount_fails(fake_archil, session, monkeypatch):
    mount = local_mount(path="data")
    mount_path = await mount.attach(session)
    monkeypatch.setenv("FAKE_UNMOUNT_FAILS", "1")

    await mount.detach(session)

    calls = fake_archil()
    release = calls[calls.index(f"unmount {mount_path}") :]
    assert release == [
        f"unmount {mount_path}",
        f"sync {mount_path}",
        f"delegations {mount_path} --json",
        f"checkin {mount_path}/sub/dir",
        f"checkin {mount_path}",
    ]


async def test_read_only_detach_does_not_check_in(fake_archil, session, monkeypatch):
    mount = local_mount(path="data", read_only=True)
    mount_path = await mount.attach(session)
    monkeypatch.setenv("FAKE_UNMOUNT_FAILS", "1")

    await mount.detach(session)

    assert fake_archil()[-1] == f"unmount {mount_path}"


async def test_unwritable_root_is_handed_to_the_default_user(fake_archil, session, monkeypatch):
    monkeypatch.setenv("FAKE_ROOT_NOT_WRITABLE", "1")
    mount_path = await local_mount(path="data").attach(session)
    Path(mount_path).chmod(0o755)

    owner = f"{os.getuid()}:{os.getgid()}"
    assert f"chown {owner} {mount_path}" in fake_archil()


@pytest.mark.parametrize("options", [{"read_only": True}, {"shared": True}, {"make_writable": False}])
async def test_ownership_is_left_alone_unless_writable_and_exclusive(fake_archil, session, monkeypatch, options):
    monkeypatch.setenv("FAKE_ROOT_NOT_WRITABLE", "1")
    mount_path = await local_mount(path="data", **options).attach(session)
    Path(mount_path).chmod(0o755)

    assert not any(call.startswith("chown") for call in fake_archil())


async def test_mount_failure_raises_and_cleans_up(fake_archil, session, monkeypatch):
    monkeypatch.setenv("FAKE_MOUNT_FAILS", "1")

    with pytest.raises(ArchilMountError, match="mount refused"):
        await local_mount(path="data").attach(session)
    await session.aclose()

    root = Path(session.state.manifest.root)
    assert not list(root.glob(".archil-mount-token-*"))
    assert not any(call.startswith("unmount") for call in fake_archil())


async def test_attaching_twice_to_one_session_is_rejected(fake_archil, session):
    mount = local_mount(path="data")
    await mount.attach(session)

    with pytest.raises(ValueError, match="already attached"):
        await mount.attach(session)


@pytest.mark.parametrize("path", ["../escape", "data/../../escape", "."])
async def test_paths_outside_or_at_the_workspace_root_are_rejected(fake_archil, session, path):
    with pytest.raises(ValueError):
        await local_mount(path=path).attach(session)
    assert fake_archil() == []


async def test_missing_token_is_rejected(fake_archil, session):
    with pytest.raises(ValueError, match="ARCHIL_MOUNT_TOKEN"):
        await local_mount(token=None).attach(session)


def test_shared_and_conditional_are_mutually_exclusive():
    with pytest.raises(ValueError, match="mutually exclusive"):
        local_mount(shared=True, conditional=True)


async def test_conditional_mount_hands_an_unwritable_root_to_the_default_user(fake_archil, session, monkeypatch):
    monkeypatch.setenv("FAKE_ROOT_NOT_WRITABLE", "1")
    mount_path = await local_mount(path="data", conditional=True).attach(session)
    Path(mount_path).chmod(0o755)

    assert f"chown {os.getuid()}:{os.getgid()} {mount_path}" in fake_archil()


def test_repr_hides_the_token():
    assert TOKEN not in repr(local_mount())
