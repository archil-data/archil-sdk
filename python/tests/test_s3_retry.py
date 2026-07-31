import httpx
import pytest

from archil import ArchilS3Error
from conftest import ok_envelope

DISK_JSON = {
    "id": "dsk-1",
    "name": "my-disk",
    "organization": "org-1",
    "status": "available",
    "provider": "aws",
    "region": "aws-us-east-1",
    "createdAt": "2026-01-01T00:00:00Z",
}


def _disk(archil):
    return archil.disks.get("dsk-1")


def test_retries_transient_5xx_then_succeeds(archil, router):
    attempts = {"n": 0}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        if req.method == "PUT":
            attempts["n"] += 1
            # Fail the first two attempts with a transient 500, then succeed.
            if attempts["n"] < 3:
                return httpx.Response(500, content=b"<Error><Code>InternalError</Code></Error>")
            return httpx.Response(200, headers={"etag": '"ok"'})
        return httpx.Response(404)

    router.set(handler)
    res = _disk(archil).put_object("k.txt", b"body")
    assert res.etag == '"ok"'
    assert attempts["n"] == 3  # retried twice before succeeding


def test_does_not_retry_4xx(archil, router):
    attempts = {"n": 0}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        if req.method == "PUT":
            attempts["n"] += 1
            return httpx.Response(
                400, content=b"<Error><Code>BadDigest</Code><Message>nope</Message></Error>"
            )
        return httpx.Response(404)

    router.set(handler)
    with pytest.raises(ArchilS3Error) as exc:
        _disk(archil).put_object("k.txt", b"body")
    assert exc.value.status == 400
    assert exc.value.code == "BadDigest"
    assert attempts["n"] == 1  # a 4xx must not be retried


def test_gives_up_after_retry_budget(archil, router):
    attempts = {"n": 0}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        if req.method == "GET":
            attempts["n"] += 1
            return httpx.Response(503, content=b"<Error><Code>InternalError</Code></Error>")
        return httpx.Response(404)

    router.set(handler)
    with pytest.raises(ArchilS3Error) as exc:
        _disk(archil).get_object("k.txt")
    assert exc.value.status == 503
    assert attempts["n"] == 4  # 1 initial attempt + 3 retries


def test_complete_multipart_is_not_retried(archil, router):
    attempts = {"n": 0}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        if req.method == "POST" and "uploadId" in req.url.params:
            attempts["n"] += 1
            return httpx.Response(500, content=b"<Error><Code>InternalError</Code></Error>")
        return httpx.Response(404)

    router.set(handler)
    from archil import UploadPart

    with pytest.raises(ArchilS3Error) as exc:
        _disk(archil).multipart.complete("big.bin", "u1", [UploadPart(part_number=1, etag='"a"')])
    assert exc.value.status == 500
    # Complete is non-idempotent on our gateway, so it must not be auto-retried.
    assert attempts["n"] == 1


def test_append_object_is_not_retried(archil, router):
    attempts = {"n": 0}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        if req.method == "PUT" and "append" in req.url.params:
            attempts["n"] += 1
            return httpx.Response(500, content=b"<Error><Code>InternalError</Code></Error>")
        return httpx.Response(404)

    router.set(handler)
    with pytest.raises(ArchilS3Error) as exc:
        _disk(archil).append_object("log.txt", b"line\n")
    assert exc.value.status == 500
    # Append is non-idempotent on our gateway, so it must not be auto-retried.
    assert attempts["n"] == 1


def test_retries_transport_error_then_succeeds(archil, router):
    attempts = {"n": 0}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        if req.method == "GET":
            attempts["n"] += 1
            if attempts["n"] < 2:
                raise httpx.ConnectError("boom", request=req)
            return httpx.Response(200, content=b"hello")
        return httpx.Response(404)

    router.set(handler)
    got = _disk(archil).get_object("k.txt")
    assert got == b"hello"
    assert attempts["n"] == 2  # one network failure, then success
