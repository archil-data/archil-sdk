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

from archil._archil import ExecMountSpec
from archil._models import GrepGroup, GrepGroupLine, GrepMatch, GrepResult, ListObjectsResult, S3Object
from archil._paths import to_segments
from archil._workspace import _Workspace
from archil.errors import ArchilApiError


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

    async def grep(self, *, directory, globs=None, **_):
        self.calls["grep_dir"] = directory
        self.calls["grep_globs"] = globs
        return GrepResult(
            matches=[], stopped_reason="completed", files_scanned=0,
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


class _RejectingDisk:
    def __init__(self, status: int, message: str) -> None:
        self.error = ArchilApiError(message, status, "bad_request" if status == 400 else None)

    async def grep(self, *, directory, **_):
        raise self.error


def test_workspace_grep_reports_a_bad_request_instead_of_a_partial_result():
    # The control plane rejects a bad request on every disk alike.
    unknown_type = 'unknown file type "pyy"'
    bad = _ws(data=_RejectingDisk(400, unknown_type), cache=_RejectingDisk(400, unknown_type))
    with pytest.raises(ArchilApiError, match=unknown_type) as exc:
        asyncio.run(bad.grep(directory="", pattern="x", types=["pyy"]))
    assert exc.value.status == 400
    # Any other failure is one disk's, so the rest still come back.
    down = _ws(ok=_FakeDisk("ok"), bad=_RejectingDisk(503, "No runtime capacity available, please retry shortly"))
    assert asyncio.run(down.grep(directory="", pattern="x")).stopped_reason == "list_failed"


class _MatchingDisk:
    async def grep(self, *, directory, **_):
        return GrepResult(
            matches=[GrepMatch("a.txt", 1, "x"), GrepMatch("b.txt", 2, "x")],
            stopped_reason="completed", files_scanned=1, containers_dispatched=0,
            compute_seconds_used=0.0, duration_ms=0, listing_ms=0, grep_ms=0,
        )


def test_workspace_grep_flags_max_results_across_disks():
    ws = _ws(data=_MatchingDisk(), cache=_MatchingDisk())
    # 2 + 2 = 4 merged matches, cap 3 → must be flagged truncated, not silent.
    r = asyncio.run(ws.grep(directory="", pattern="x", max_results=3))
    assert len(r.matches) == 3
    assert r.stopped_reason == "max_results"
    assert r.groups is None


def _lines(*specs: tuple[int, bool]) -> list[GrepGroupLine]:
    return [GrepGroupLine(n, "x" if m else "-", m) for n, m in specs]


class _GroupedDisk:
    def __init__(self, matches: list[GrepMatch], groups: list[GrepGroup]) -> None:
        self.matches = matches
        self.groups = groups
        self.kwargs: dict = {}

    async def grep(self, *, directory, **kwargs):
        self.kwargs = kwargs
        return GrepResult(
            matches=self.matches, stopped_reason="completed", files_scanned=1,
            containers_dispatched=0, compute_seconds_used=0.0, duration_ms=0,
            listing_ms=0, grep_ms=0, groups=self.groups,
        )


def test_workspace_grep_forwards_options_and_merges_groups_within_cap():
    data = _GroupedDisk(
        [GrepMatch("a.txt", 1, "x"), GrepMatch("a.txt", 3, "x\nx", end_line=4)],
        [GrepGroup("a.txt", _lines((1, True), (2, False), (3, True), (4, True)))],
    )
    cache = _GroupedDisk(
        [GrepMatch("b.txt", 5, "x"), GrepMatch("b.txt", 7, "x")],
        [GrepGroup("b.txt", _lines((5, True), (6, False), (7, True), (8, False)))],
    )
    ws = _ws(data=data, cache=cache)
    r = asyncio.run(
        ws.grep(
            directory="", pattern="x", max_results=3, multiline=True,
            ignore_case=True, globs=["*.txt"], context_after=2,
        )
    )
    for disk in (data, cache):
        assert disk.kwargs["multiline"] is True
        assert disk.kwargs["ignore_case"] is True
        assert disk.kwargs["globs"] == ["*.txt"]
        assert disk.kwargs["context_after"] == 2
    assert r.matches[1] == GrepMatch("data/a.txt", 3, "x\nx", end_line=4)
    # The multiline run on lines 3-4 counts once, so the cap lands on b.txt:5.
    # b.txt:7 falls in its after-context and comes back as context.
    assert r.groups == [
        GrepGroup("data/a.txt", _lines((1, True), (2, False), (3, True), (4, True))),
        GrepGroup("cache/b.txt", [*_lines((5, True), (6, False)), GrepGroupLine(7, "x", False)]),
    ]


def test_workspace_grep_trims_merged_groups_at_the_cap():
    a = _lines((1, False), (2, True), (3, False), (4, True), (5, False))
    data = _GroupedDisk([GrepMatch("a.txt", 2, "x"), GrepMatch("a.txt", 4, "x")], [GrepGroup("a.txt", a)])
    cache = _GroupedDisk(
        [GrepMatch("b.txt", 2, "x"), GrepMatch("b.txt", 3, "x"), GrepMatch("b.txt", 9, "x")],
        [
            GrepGroup("b.txt", _lines((1, False), (2, True), (3, True), (4, False), (5, False))),
            GrepGroup("b.txt", _lines((8, False), (9, True), (10, False))),
        ],
    )
    ws = _ws(data=data, cache=cache)
    # Without multiline, b.txt:3 is a match of its own, so the cap lands on
    # b.txt:2. b.txt:3 falls in its after-context and comes back as context, the
    # group ends after context_after lines, and b.txt's later group is dropped.
    trimmed = asyncio.run(
        ws.grep(directory="", pattern="x", max_results=3, context_before=1, context_after=2)
    )
    assert trimmed.groups == [
        GrepGroup("data/a.txt", a),
        GrepGroup("cache/b.txt", [*_lines((1, False), (2, True)), GrepGroupLine(3, "x", False), *_lines((4, False))]),
    ]

    # With multiline, a cap landing on a run that ends its group keeps the
    # whole run, even without after-context.
    run = _ws(
        data=_GroupedDisk(
            [GrepMatch("a.txt", 1, "x\nx", end_line=2), GrepMatch("a.txt", 5, "x")],
            [GrepGroup("a.txt", _lines((1, True), (2, True))), GrepGroup("a.txt", _lines((4, False), (5, True)))],
        )
    )
    r = asyncio.run(run.grep(directory="", pattern="x", max_results=1, multiline=True, context_before=1))
    assert r.groups == [GrepGroup("data/a.txt", _lines((1, True), (2, True)))]


def test_workspace_grep_routes_root_globs_by_mount_name():
    disks = {name: _FakeDisk(name) for name in ("data", "cache", "logs")}
    ws = _ws(**disks)

    def globs_sent(directory: str, globs: list[str]) -> dict:
        for d in disks.values():
            d.calls.clear()
        asyncio.run(ws.grep(directory=directory, pattern="x", globs=globs))
        return {name: d.calls["grep_globs"] for name, d in disks.items() if "grep_globs" in d.calls}

    # A glob starting with a mount name reaches only that mount, without the
    # name, while one with no `/` or starting with `**/` reaches every mount.
    assert globs_sent("", ["data/src/**", "*.ts", "!cache/tmp/**", "!**/node_modules/**"]) == {
        "data": ["src/**", "*.ts", "!**/node_modules/**"],
        "cache": ["*.ts", "!tmp/**", "!**/node_modules/**"],
        "logs": ["*.ts", "!**/node_modules/**"],
    }
    # Left without a `/`, these would match at any depth, so they're anchored. A
    # mount no include reaches isn't searched.
    assert globs_sent("", ["/data/*.csv", "data/*.json", "data/**"]) == {"data": ["/*.csv", "/*.json", "/**"]}
    # An exclude naming a mount exactly skips it, and one with no `/` of its own
    # still applies inside the other mounts. A wildcard applies only inside them.
    assert globs_sent("", ["!/logs"]) == {"data": [], "cache": []}
    assert globs_sent("", ["!logs", "!cache/"]) == {"data": ["!logs", "!cache/"]}
    assert globs_sent("", ["!l*"]) == {"data": ["!l*"], "cache": ["!l*"], "logs": ["!l*"]}
    # After a leading `**/`, a mount name also reaches the paths under that mount.
    assert globs_sent("", ["**/logs/**", "!**/cache"]) == {
        "data": ["**/logs/**", "!**/cache"],
        "logs": ["**/logs/**", "/**", "!**/cache"],
    }
    # The control plane still checks the glob after the mount name.
    assert globs_sent("", ["data/[", "["]) == {"data": ["/[", "["], "cache": ["["], "logs": ["["]}
    # Any other glob with a `/` is refused.
    for glob in ("*/src/**", "{data,cache}/**", "dta/**", "/*.csv"):
        with pytest.raises(ValueError, match="must start with a mount name"):
            asyncio.run(ws.grep(directory="", pattern="x", globs=[glob]))
    # Below the root, globs are already relative to the disk's directory.
    assert globs_sent("data/src", ["lib/**"]) == {"data": ["lib/**"]}


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
