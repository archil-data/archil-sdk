"""Unit tests for path routing (pure logic, no real I/O).

Path resolution has the most combinatorial surface (the disk root, workspace
disk-name routing, subdirectories, relative vs absolute, fan-out) and is where
routing bugs have clustered — so it gets focused coverage here: ``to_segments``
(normalization) directly, and ``_Workspace`` routing through its public
FileSystem methods with fake disks, separate from the transport-level tests in
test_agent_tools.py."""

from __future__ import annotations

import asyncio

import pytest

from archil import GrepMatch, GrepResult, GrepStoppedReason
from archil._archil import ExecMountSpec
from archil._models import ListObjectsResult, S3Object
from archil._paths import to_segments
from archil._workspace import _Workspace


class _FakeDisk:
    """A Disk stand-in recording the key/prefix/directory each method is asked
    for, so routing can be asserted without any real I/O."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: dict[str, object] = {}

    async def get_object(self, key: str) -> bytes:
        self.calls["get"] = key
        return b""

    async def put_object(self, key: str, body, content_type=None):
        self.calls["put"] = key
        return None

    async def delete_object(self, key: str) -> None:
        self.calls["delete"] = key

    async def list_objects(self, prefix=None, *, recursive=False):
        self.calls["list_prefix"] = prefix
        return ListObjectsResult(
            objects=[S3Object(key="logs/x.txt", size=3)],
            common_prefixes=[],
            is_truncated=False,
            key_count=1,
        )

    async def grep(self, *, directory, **_):
        self.calls["grep_dir"] = directory
        return GrepResult(
            matches=[], stopped_reason=GrepStoppedReason.COMPLETED, files_scanned=0,
            containers_dispatched=0, compute_seconds_used=0.0,
            duration_ms=0, listing_ms=0, grep_ms=0,
        )


class _FakeClient:
    def __init__(self) -> None:
        self.exec_call: dict = {}

    async def exec(self, *, disks, command):
        self.exec_call = {"disks": disks, "command": command}
        return None


def _ws(**mounts) -> _Workspace:
    return _Workspace(_FakeClient(), mounts)


# --- to_segments -----------------------------------------------------------


@pytest.mark.parametrize(
    "path,expected",
    [
        ("/a/b.txt", ["a", "b.txt"]),
        ("a/b.txt", ["a", "b.txt"]),  # leading slash optional
        ("/", []),  # root
        ("/a/b/../c.txt", ["a", "c.txt"]),
        ("/a/./b", ["a", "b"]),
        ("/../../etc/x", ["etc", "x"]),  # can't escape root
    ],
)
def test_to_segments_normalizes(path, expected):
    assert to_segments(path) == expected


@pytest.mark.parametrize(
    "path,root,expected",
    [
        ("/mnt/a/b.txt", "/mnt", ["a", "b.txt"]),
        ("/mnt", "/mnt", []),
        ("/mnt/archil/data/q.txt", "/mnt/archil", ["data", "q.txt"]),
    ],
)
def test_to_segments_strips_container_root(path, root, expected):
    assert to_segments(path, root) == expected


# --- workspace routing -----------------------------------------------------


def test_workspace_routes_by_first_segment():
    data, cache = _FakeDisk("data"), _FakeDisk("cache")
    ws = _ws(data=data, cache=cache)
    asyncio.run(ws.get_object("data/x/y.txt"))
    assert data.calls["get"] == "x/y.txt"
    asyncio.run(ws.get_object("/cache/z.txt"))  # leading slash tolerated
    assert cache.calls["get"] == "z.txt"


def test_workspace_subdirectory_prefixes_key():
    data = _FakeDisk("data")
    ws = _ws(data=ExecMountSpec(disk=data, subdirectory="sub"))
    asyncio.run(ws.get_object("data/a.txt"))
    assert data.calls["get"] == "sub/a.txt"


def test_workspace_exact_disk_name_match():
    data, archive = _FakeDisk("data"), _FakeDisk("data-archive")
    ws = _ws(data=data, **{"data-archive": archive})
    asyncio.run(ws.get_object("data-archive/f.txt"))
    assert archive.calls["get"] == "f.txt"
    assert "get" not in data.calls


def test_dotdot_routes_to_the_right_disk():
    data, cache = _FakeDisk("data"), _FakeDisk("cache")
    ws = _ws(data=data, cache=cache)
    asyncio.run(ws.get_object("data/../cache/x.txt"))
    assert cache.calls["get"] == "x.txt"
    assert "get" not in data.calls


@pytest.mark.parametrize("key", ["other/x", "/", "x"])
def test_workspace_rejects_unknown_disk_or_root(key):
    with pytest.raises(ValueError):
        asyncio.run(_ws(data=_FakeDisk("data"), cache=_FakeDisk("cache")).get_object(key))


def test_workspace_rejects_nested_mount_name():
    with pytest.raises(ValueError, match="must not contain"):
        _ws(**{"a/b": _FakeDisk("x")})


@pytest.mark.parametrize("name", [".", ".."])
def test_workspace_rejects_reserved_mount_name(name):
    with pytest.raises(ValueError, match="reserved"):
        _ws(**{name: _FakeDisk("x")})


# --- fan-out / listing -----------------------------------------------------


def test_workspace_root_lists_the_disks_themselves():
    data, cache = _FakeDisk("data"), _FakeDisk("cache")
    ws = _ws(data=data, cache=cache)
    result = asyncio.run(ws.list_objects())
    # The disks are the top-level directories; their contents aren't fanned into.
    assert result.common_prefixes == ["cache/", "data/"]
    assert result.objects == []
    assert "list_prefix" not in data.calls  # disks not even queried


def test_workspace_recursive_root_fans_out_with_disk_prefixed_keys():
    ws = _ws(data=_FakeDisk("data"), cache=_FakeDisk("cache"))
    result = asyncio.run(ws.list_objects(recursive=True))
    assert sorted(o.key for o in result.objects) == ["cache/logs/x.txt", "data/logs/x.txt"]


def test_workspace_directory_lists_only_its_disk():
    data, cache = _FakeDisk("data"), _FakeDisk("cache")
    ws = _ws(data=data, cache=cache)
    asyncio.run(ws.list_objects("data/logs/"))
    assert data.calls["list_prefix"] == "logs/"
    assert "list_prefix" not in cache.calls


class _FailingDisk:
    async def list_objects(self, *a, **k):
        raise RuntimeError("boom")

    async def grep(self, *, directory, **_):
        raise RuntimeError("boom")


def test_workspace_failing_disk_does_not_sink_fan_out():
    ws = _ws(ok=_FakeDisk("ok"), bad=_FailingDisk())
    # grep: the bad disk surfaces as a partial-results reason, ok's run is kept.
    g = asyncio.run(ws.grep(directory="", pattern="x"))
    assert g.stopped_reason == "list_failed"
    # list_objects (recursive, so it fans out): ok's keys are returned and the
    # result is flagged incomplete.
    listing = asyncio.run(ws.list_objects(recursive=True))
    assert [o.key for o in listing.objects] == ["ok/logs/x.txt"]
    assert listing.is_truncated is True


class _MatchingDisk:
    async def grep(self, *, directory, **_):
        return GrepResult(
            matches=[GrepMatch("a.txt", 1, "x"), GrepMatch("b.txt", 2, "x")],
            stopped_reason=GrepStoppedReason.COMPLETED, files_scanned=1, containers_dispatched=0,
            compute_seconds_used=0.0, duration_ms=0, listing_ms=0, grep_ms=0,
        )


def test_workspace_grep_flags_max_results_across_disks():
    ws = _ws(data=_MatchingDisk(), cache=_MatchingDisk())
    # 2 + 2 = 4 merged matches, cap 3 → must be flagged truncated, not silent.
    r = asyncio.run(ws.grep(directory="", pattern="x", max_results=3))
    assert len(r.matches) == 3
    assert r.stopped_reason == "max_results"


# --- read-only -------------------------------------------------------------


def test_workspace_read_only_blocks_writes_and_deletes():
    data = _FakeDisk("data")
    ws = _ws(data=ExecMountSpec(disk=data, read_only=True))
    with pytest.raises(ValueError, match="read-only"):
        asyncio.run(ws.put_object("data/a.txt", "x"))
    with pytest.raises(ValueError, match="read-only"):
        asyncio.run(ws.delete_object("data/a.txt"))
    assert "put" not in data.calls
    assert "delete" not in data.calls


# --- runtime mount management ----------------------------------------------


def test_workspace_add_and_remove_disks_at_runtime():
    data = _FakeDisk("data")
    ws = _ws(data=data)
    assert ws.disk_names() == ["data"]

    extra = _FakeDisk("extra")
    ws.add_disk("extra", extra)
    assert sorted(ws.disk_names()) == ["data", "extra"]
    asyncio.run(ws.get_object("extra/f.txt"))
    assert extra.calls["get"] == "f.txt"

    assert ws.remove_disk("extra") is True
    assert ws.disk_names() == ["data"]
    with pytest.raises(ValueError, match="No disk named 'extra'"):
        asyncio.run(ws.get_object("extra/f.txt"))
