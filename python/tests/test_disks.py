import httpx
import pytest

from archil import ArchilApiError, Disk, S3CompatibleMount
from conftest import ok_envelope, error_envelope

DISK_JSON = {
    "id": "dsk-1",
    "name": "my-disk",
    "organization": "org-1",
    "status": "available",
    "provider": "aws",
    "region": "aws-us-east-1",
    "createdAt": "2026-01-01T00:00:00Z",
    "activeDataBytes": 1234,
    "totalDataBytes": 5678,
    "allowedIps": ["10.0.0.0/8"],
}


def test_list_disks(archil, router):
    router.set(lambda req: ok_envelope([DISK_JSON, {**DISK_JSON, "id": "dsk-2"}]))
    disks = archil.disks.list()
    assert [d.id for d in disks] == ["dsk-1", "dsk-2"]
    assert isinstance(disks[0], Disk)
    assert disks[0].name == "my-disk"
    assert disks[0].active_data_bytes == 1234
    assert disks[0].total_data_bytes == 5678
    assert disks[0].allowed_ips == ["10.0.0.0/8"]
    # auth header carries the single key- prefix
    assert router.requests[0].headers["authorization"] == "key-test"


def test_list_disks_passes_query(archil, router):
    router.set(lambda req: ok_envelope([]))
    archil.disks.list(limit=5, name="foo")
    q = router.requests[0].query
    assert q["limit"] == "5"
    assert q["name"] == "foo"
    assert "cursor" not in q  # None params are dropped


def _disk(i: int) -> dict:
    return {**DISK_JSON, "id": f"dsk-{i}"}


def test_list_disks_follows_next_cursor(archil, router):
    pages = {None: ([_disk(1), _disk(2)], "c1"), "c1": ([_disk(3)], None)}

    def handler(req):
        data, nxt = pages[req.url.params.get("cursor")]
        return ok_envelope(data, next_cursor=nxt)

    router.set(handler)
    disks = archil.disks.list()
    assert [d.id for d in disks] == ["dsk-1", "dsk-2", "dsk-3"]
    # The default path paginates: bounded server work per request.
    assert router.requests[0].query["limit"] == "100"
    assert "cursor" not in router.requests[0].query
    assert router.requests[1].query["cursor"] == "c1"


def test_list_disks_limit_spans_pages(archil, router):
    pages = {None: ([_disk(1), _disk(2)], "c1"), "c1": ([_disk(3), _disk(4)], "c2")}

    def handler(req):
        data, nxt = pages[req.url.params.get("cursor")]
        return ok_envelope(data, next_cursor=nxt)

    router.set(handler)
    disks = archil.disks.list(limit=3)
    assert [d.id for d in disks] == ["dsk-1", "dsk-2", "dsk-3"]
    # Each request asks only for what's still needed, and the walk stops at the cap.
    assert router.requests[0].query["limit"] == "3"
    assert router.requests[1].query["limit"] == "1"
    assert len(router.requests) == 2


def test_list_disks_caps_when_server_ignores_limit(archil, router):
    # A server that predates pagination returns the full list regardless of limit.
    router.set(lambda req: ok_envelope([_disk(1), _disk(2), _disk(3)]))
    disks = archil.disks.list(limit=2)
    assert [d.id for d in disks] == ["dsk-1", "dsk-2"]


def test_list_disks_repeated_cursor_terminates(archil, router):
    router.set(lambda req: ok_envelope([_disk(1)], next_cursor="same"))
    archil.disks.list()
    assert len(router.requests) == 2  # no forward progress -> stop


def test_list_disks_name_filter_is_single_request(archil, router):
    # nextCursor on a name-filtered response must not trigger a pagination walk.
    router.set(lambda req: ok_envelope([_disk(1)], next_cursor="c1"))
    disks = archil.disks.list(name="my-disk")
    assert [d.id for d in disks] == ["dsk-1"]
    assert len(router.requests) == 1
    assert router.requests[0].query["name"] == "my-disk"


def test_list_pages(archil, router):
    pages = {None: ([_disk(1), _disk(2)], "c1"), "c1": ([_disk(3)], None)}

    def handler(req):
        data, nxt = pages[req.url.params.get("cursor")]
        return ok_envelope(data, next_cursor=nxt)

    router.set(handler)
    walked = list(archil.disks.list_pages(page_size=2))
    assert [([d.id for d in p.disks], p.next_cursor) for p in walked] == [
        (["dsk-1", "dsk-2"], "c1"),
        (["dsk-3"], None),
    ]
    # Pages hand back public wrappers, like CreateDiskResult.disk.
    assert isinstance(walked[0].disks[0], Disk)
    assert router.requests[0].query["limit"] == "2"
    assert router.requests[1].query["cursor"] == "c1"


def test_get_disk(archil, router):
    router.set(lambda req: ok_envelope(DISK_JSON))
    d = archil.disks.get("dsk-1")
    assert d.id == "dsk-1"
    assert router.requests[0].path == "/api/disks/dsk-1"


def test_create_disk_returns_translated_disk_and_token(archil, router):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "POST" and req.url.path == "/api/disks":
            return ok_envelope(
                {
                    "diskId": "dsk-1",
                    "authorizedUsers": [
                        {"type": "token", "token": "dt-secret", "identifier": "tok-1"}
                    ],
                }
            )
        return ok_envelope(DISK_JSON)

    router.set(handler)
    result = archil.disks.create(
        name="my-disk",
        mounts=[
            S3CompatibleMount(
                bucket_name="b",
                bucket_endpoint="http://e",
                access_key_id="ak",
                secret_access_key="sk",
            )
        ],
    )
    assert result.token == "dt-secret"
    assert result.token_identifier == "tok-1"
    # The disk handed back must be the public (blocking) wrapper, not the impl —
    # this guards the _translate_out plumbing in _Disks.create.
    assert isinstance(result.disk, Disk)
    assert result.disk.id == "dsk-1"

    # The POST body serialized the mount to camelCase with the discriminator.
    body = router.requests[0].json
    assert body["name"] == "my-disk"
    assert body["mounts"][0] == {
        "type": "s3-compatible",
        "bucketName": "b",
        "bucketEndpoint": "http://e",
        "accessKeyId": "ak",
        "secretAccessKey": "sk",
    }


def test_disk_preserves_empty_arrays(archil, router):
    router.set(lambda req: ok_envelope({**DISK_JSON, "mounts": [], "connectedClients": [], "authorizedUsers": []}))
    d = archil.disks.get("dsk-1")
    assert d.mounts == [] and d.connected_clients == [] and d.authorized_users == []


def test_public_models_use_none_for_missing_optional_fields(archil, router):
    router.set(lambda req: ok_envelope(DISK_JSON))
    disk = archil.disks.get("dsk-1")

    assert disk.fs_handler_status is None
    assert disk.last_accessed is None
    assert disk.metrics is None
    assert disk.monthly_usage is None
    assert S3CompatibleMount(
        bucket_name="b",
        bucket_endpoint="http://e",
        access_key_id="ak",
        secret_access_key="sk",
    ).bucket_prefix is None


def test_list_disks_empty_data(archil, router):
    router.set(lambda req: ok_envelope([]))
    assert archil.disks.list() == []


def test_create_disk_null_authorized_users(archil, router):
    def handler(req):
        if req.method == "POST" and req.url.path == "/api/disks":
            return ok_envelope({"diskId": "dsk-1", "authorizedUsers": None})
        return ok_envelope(DISK_JSON)

    router.set(handler)
    result = archil.disks.create(name="d")
    assert result.authorized_users == []
    assert result.token is None
    assert result.disk.id == "dsk-1"


def test_envelope_failure_raises_api_error(archil, router):
    router.set(lambda req: error_envelope(404, "disk not found"))
    with pytest.raises(ArchilApiError) as exc:
        archil.disks.get("dsk-x")
    assert exc.value.status == 404
    assert "not found" in str(exc.value)


def test_api_error_surfaces_code_when_present(archil, router):
    router.set(lambda req: httpx.Response(404, json={"success": False, "error": "nope", "code": "DISK_NOT_FOUND"}))
    with pytest.raises(ArchilApiError) as exc:
        archil.disks.get("dsk-x")
    assert exc.value.code == "DISK_NOT_FOUND"


def test_refresh_returns_fresh_snapshot(archil, router):
    state = {"status": "creating"}
    router.set(lambda req: ok_envelope({**DISK_JSON, "status": state["status"]}))
    d = archil.disks.get("dsk-1")
    assert d.status == "creating"
    state["status"] = "available"
    d2 = d.refresh()
    assert d2.status == "available"
    assert d.status == "creating"  # original snapshot is immutable


def test_wait_until_ready(archil, router):
    seq = iter(["creating", "creating", "available"])
    router.set(lambda req: ok_envelope({**DISK_JSON, "status": next(seq)}))
    d = archil.disks.get("dsk-1")
    ready = d.wait_until_ready(poll_interval=0.0, timeout=10)
    assert ready.status == "available"


@pytest.mark.parametrize("terminal", ["failed", "deleted", "deleting"])
def test_wait_until_ready_terminal_failure(archil, router, terminal):
    # `deleting` is terminal too — it will never become available, so fail fast
    # rather than spin to the timeout.
    router.set(lambda req: ok_envelope({**DISK_JSON, "status": terminal}))
    d = archil.disks.get("dsk-1")
    with pytest.raises(RuntimeError, match="terminal status"):
        d.wait_until_ready(poll_interval=0.0, timeout=10)
