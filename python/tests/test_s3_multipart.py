import hashlib
import re
from urllib.parse import unquote

import httpx
import pytest

from archil import ArchilS3Error
from conftest import ok_envelope, s3_error

DISK_JSON = {
    "id": "dsk-1",
    "name": "my-disk",
    "organization": "org-1",
    "status": "available",
    "provider": "aws",
    "region": "aws-us-east-1",
    "createdAt": "2026-01-01T00:00:00Z",
}


def _multipart_etag(part_md5_digests: list[bytes]) -> str:
    """The S3 multipart ETag: md5(concat(part md5 digests))-N, quoted."""
    joined = b"".join(part_md5_digests)
    return f'"{hashlib.md5(joined).hexdigest()}-{len(part_md5_digests)}"'


class MockMultipartS3:
    """In-memory S3-compatible store covering multipart upload + DeleteObjects so
    the SDK's real request building and XML parsing are exercised end-to-end."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        # upload_id -> {"key": str, "parts": {part_number: bytes}}
        self.uploads: dict[str, dict] = {}
        self._next_upload = 0
        # Keys the server should fail to delete (key -> (code, message)).
        self.delete_failures: dict[str, tuple[str, str]] = {}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)

        params = req.url.params
        rel = req.url.path[len("/dsk-1") :].lstrip("/")
        key = unquote(rel)

        if req.method == "POST" and "delete" in params:
            return self._delete_objects(req)
        if req.method == "POST" and "uploads" in params:
            return self._initiate(key)
        if req.method == "POST" and "uploadId" in params:
            return self._complete(req, key, params["uploadId"])
        if req.method == "PUT" and "uploadId" in params:
            return self._upload_part(req, params["uploadId"], int(params["partNumber"]))
        if req.method == "DELETE" and "uploadId" in params:
            return self._abort(params["uploadId"])
        if req.method == "GET" and "uploadId" in params:
            return self._list_parts(key, params["uploadId"])
        if req.method == "GET" and "uploads" in params:
            return self._list_multipart_uploads()
        if req.method == "PUT":
            self.objects[key] = req.content
            return httpx.Response(200, headers={"etag": '"' + hashlib.md5(req.content).hexdigest() + '"'})

        return httpx.Response(405)

    # -- multipart --

    def _initiate(self, key: str) -> httpx.Response:
        self._next_upload += 1
        upload_id = f"upload-{self._next_upload}"
        self.uploads[upload_id] = {"key": key, "parts": {}}
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<InitiateMultipartUploadResult>"
            "<Bucket>dsk-1</Bucket>"
            f"<Key>{key}</Key>"
            f"<UploadId>{upload_id}</UploadId>"
            "</InitiateMultipartUploadResult>"
        )
        return httpx.Response(200, content=body.encode(), headers={"content-type": "application/xml"})

    def _upload_part(self, req: httpx.Request, upload_id: str, part_number: int) -> httpx.Response:
        if upload_id not in self.uploads:
            return s3_error(404, "NoSuchUpload", "The specified upload does not exist.")
        self.uploads[upload_id]["parts"][part_number] = req.content
        etag = '"' + hashlib.md5(req.content).hexdigest() + '"'
        return httpx.Response(200, headers={"etag": etag})

    def _complete(self, req: httpx.Request, key: str, upload_id: str) -> httpx.Response:
        if upload_id not in self.uploads:
            return s3_error(404, "NoSuchUpload", "The specified upload does not exist.")
        listed = [int(n) for n in re.findall(r"<PartNumber>(\d+)</PartNumber>", req.content.decode())]
        # The SDK must submit parts in strictly-increasing order.
        assert listed == sorted(listed), f"parts not in ascending order: {listed}"
        stored = self.uploads[upload_id]["parts"]
        assembled = b"".join(stored[n] for n in listed)
        digests = [hashlib.md5(stored[n]).digest() for n in listed]
        self.objects[key] = assembled
        del self.uploads[upload_id]
        etag = _multipart_etag(digests)
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<CompleteMultipartUploadResult>"
            f"<Location>/dsk-1/{key}</Location>"
            "<Bucket>dsk-1</Bucket>"
            f"<Key>{key}</Key>"
            f"<ETag>{etag}</ETag>"
            "</CompleteMultipartUploadResult>"
        )
        return httpx.Response(200, content=body.encode(), headers={"content-type": "application/xml"})

    def _abort(self, upload_id: str) -> httpx.Response:
        if upload_id not in self.uploads:
            return s3_error(404, "NoSuchUpload", "The specified upload does not exist.")
        del self.uploads[upload_id]
        return httpx.Response(204)

    def _list_parts(self, key: str, upload_id: str) -> httpx.Response:
        if upload_id not in self.uploads:
            return s3_error(404, "NoSuchUpload", "The specified upload does not exist.")
        parts = self.uploads[upload_id]["parts"]
        rows = []
        for n in sorted(parts):
            content = parts[n]
            etag = '"' + hashlib.md5(content).hexdigest() + '"'
            rows.append(
                f"<Part><PartNumber>{n}</PartNumber><ETag>{etag}</ETag>"
                f"<Size>{len(content)}</Size>"
                "<LastModified>2026-01-02T03:04:05.000Z</LastModified></Part>"
            )
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<ListPartsResult><Bucket>dsk-1</Bucket>"
            f"<Key>{key}</Key><UploadId>{upload_id}</UploadId>"
            "<PartNumberMarker>0</PartNumberMarker><MaxParts>1000</MaxParts>"
            "<IsTruncated>false</IsTruncated><StorageClass>STANDARD</StorageClass>"
            + "".join(rows)
            + "</ListPartsResult>"
        )
        return httpx.Response(200, content=body.encode(), headers={"content-type": "application/xml"})

    def _list_multipart_uploads(self) -> httpx.Response:
        rows = [
            f"<Upload><Key>{u['key']}</Key><UploadId>{uid}</UploadId>"
            "<Initiated>2026-01-02T03:04:05.000Z</Initiated></Upload>"
            for uid, u in self.uploads.items()
        ]
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<ListMultipartUploadsResult><Bucket>dsk-1</Bucket>"
            "<KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker>"
            "<MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>"
            + "".join(rows)
            + "</ListMultipartUploadsResult>"
        )
        return httpx.Response(200, content=body.encode(), headers={"content-type": "application/xml"})

    # -- bulk delete --

    def _delete_objects(self, req: httpx.Request) -> httpx.Response:
        quiet = "<Quiet>true</Quiet>" in req.content.decode()
        keys = re.findall(r"<Key>([^<]*)</Key>", req.content.decode())
        deleted_rows = []
        error_rows = []
        for k in keys:
            if k in self.delete_failures:
                code, msg = self.delete_failures[k]
                error_rows.append(f"<Error><Key>{k}</Key><Code>{code}</Code><Message>{msg}</Message></Error>")
                continue
            self.objects.pop(k, None)
            if not quiet:
                deleted_rows.append(f"<Deleted><Key>{k}</Key></Deleted>")
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<DeleteResult>" + "".join(deleted_rows) + "".join(error_rows) + "</DeleteResult>"
        )
        return httpx.Response(200, content=body.encode(), headers={"content-type": "application/xml"})


@pytest.fixture
def s3(router):
    store = MockMultipartS3()
    router.set(store)
    return store


def _disk(archil):
    return archil.disks.get("dsk-1")


# --- multipart, low level ---


def test_multipart_lifecycle_low_level(archil, s3):
    d = _disk(archil)
    upload = d.multipart.create("big.bin", "application/octet-stream")
    assert upload.upload_id == "upload-1"
    assert upload.key == "big.bin"
    assert upload.bucket == "dsk-1"

    a, b = b"A" * 16, b"B" * 8
    p1 = d.multipart.upload_part("big.bin", upload.upload_id, 1, a)
    p2 = d.multipart.upload_part("big.bin", upload.upload_id, 2, b)
    assert p1.part_number == 1 and p1.etag
    assert p2.part_number == 2

    listing = d.multipart.list_parts("big.bin", upload.upload_id)
    assert [p.part_number for p in listing.parts] == [1, 2]
    assert listing.parts[0].size == 16
    assert listing.is_truncated is False

    in_flight = d.multipart.list_uploads()
    assert [u.upload_id for u in in_flight.uploads] == ["upload-1"]
    assert in_flight.uploads[0].initiated is not None

    completed = d.multipart.complete("big.bin", upload.upload_id, [p1, p2])
    expected = _multipart_etag([hashlib.md5(a).digest(), hashlib.md5(b).digest()])
    assert completed.etag == expected
    assert completed.key == "big.bin"
    assert s3.objects["big.bin"] == a + b
    # The upload is gone once completed.
    assert d.multipart.list_uploads().uploads == []


def test_complete_sorts_parts_ascending(archil, s3):
    d = _disk(archil)
    upload = d.multipart.create("o.bin")
    p1 = d.multipart.upload_part("o.bin", upload.upload_id, 1, b"x" * 4)
    p2 = d.multipart.upload_part("o.bin", upload.upload_id, 2, b"y" * 4)
    # Pass parts out of order; the SDK must sort them (the mock asserts order).
    d.multipart.complete("o.bin", upload.upload_id, [p2, p1])


def test_abort_then_idempotent(archil, s3):
    d = _disk(archil)
    upload = d.multipart.create("gone.bin")
    d.multipart.abort("gone.bin", upload.upload_id)
    assert d.multipart.list_uploads().uploads == []
    # Aborting an already-gone upload is idempotent (404 → no raise).
    d.multipart.abort("gone.bin", upload.upload_id)


def test_create_multipart_missing_upload_id_raises(archil, router):
    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        return httpx.Response(
            200,
            content=b'<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>dsk-1</Bucket></InitiateMultipartUploadResult>',
        )

    router.set(handler)
    with pytest.raises(ArchilS3Error) as exc:
        _disk(archil).multipart.create("k")
    assert "UploadId" in str(exc.value)


# --- put_object auto-switch (high level) ---


def test_put_object_small_uses_single_put(archil, s3):
    d = _disk(archil)
    result = d.put_object("small.txt", b"tiny body", content_type="text/plain")
    assert s3.objects["small.txt"] == b"tiny body"
    # Single PUT etag is a plain quoted md5 (no "-N" multipart suffix).
    assert result.etag == '"' + hashlib.md5(b"tiny body").hexdigest() + '"'
    assert "-" not in result.etag
    # The small body never started a multipart upload.
    assert d.multipart.list_uploads().uploads == []


def test_put_object_large_uses_multipart(archil, s3):
    d = _disk(archil)
    # 11 MiB with a 5 MiB part size → 3 parts (5 + 5 + 1 MiB).
    payload = bytes(11 * 1024 * 1024)
    result = d.put_object("big.bin", payload, part_size=5 * 1024 * 1024)
    assert s3.objects["big.bin"] == payload
    # ETag is the 3-part composite form.
    assert result.etag.endswith('-3"')
    # All parts were uploaded; the upload is finalized (none left in flight).
    assert d.multipart.list_uploads().uploads == []


def test_put_object_threshold_forces_multipart_below_part_size(archil, s3):
    d = _disk(archil)
    # 8 MiB body is under the 16 MiB default part size, but a 5 MiB threshold
    # forces the multipart path (a single 8 MiB part — valid as the last part).
    payload = bytes(8 * 1024 * 1024)
    result = d.put_object("mid.bin", payload, multipart_threshold=5 * 1024 * 1024)
    assert s3.objects["mid.bin"] == payload
    assert result.etag.endswith('-1"')  # one-part composite ETag


def test_effective_part_size_grows_past_part_cap():
    from archil._disk import _effective_part_size

    mib = 1024 * 1024
    # Small/normal bodies keep the requested part size.
    assert _effective_part_size(100 * mib, 16 * mib) == 16 * mib
    assert _effective_part_size(10000 * 16 * mib, 16 * mib) == 16 * mib  # exactly 10,000 parts

    # A 200 GiB body would need >10,000 parts at 16 MiB; the part size grows
    # (MiB-aligned) so the count fits within the cap.
    huge = 200 * 1024 * mib
    grown = _effective_part_size(huge, 16 * mib)
    assert grown > 16 * mib
    assert grown % mib == 0
    assert (huge + grown - 1) // grown <= 10000


def test_put_object_aborts_on_part_failure(archil, router):
    state = {"uploads": 0, "aborted": []}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        params = req.url.params
        if req.method == "POST" and "uploads" in params:
            state["uploads"] += 1
            return httpx.Response(
                200,
                content=b'<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>dsk-1</Bucket><Key>k</Key><UploadId>u1</UploadId></InitiateMultipartUploadResult>',
            )
        if req.method == "PUT" and "uploadId" in params:
            # Every part upload fails.
            return s3_error(500, "InternalError", "boom")
        if req.method == "DELETE" and "uploadId" in params:
            state["aborted"].append(params["uploadId"])
            return httpx.Response(204)
        return httpx.Response(405)

    router.set(handler)
    d = _disk(archil)
    with pytest.raises(ArchilS3Error):
        d.put_object("k", bytes(11 * 1024 * 1024), part_size=5 * 1024 * 1024)
    # The failed upload was cleaned up.
    assert state["aborted"] == ["u1"]


# --- delete_objects (bulk delete) ---


def test_delete_objects_happy_path(archil, s3):
    d = _disk(archil)
    for k in ["a.txt", "b/c.txt", "d.txt"]:
        s3.objects[k] = b"x"
    result = d.delete_objects(["a.txt", "b/c.txt"])
    assert result.deleted == ["a.txt", "b/c.txt"]
    assert result.errors == []
    assert "a.txt" not in s3.objects and "b/c.txt" not in s3.objects
    assert "d.txt" in s3.objects


def test_delete_objects_reports_per_key_errors(archil, s3):
    d = _disk(archil)
    s3.delete_failures["locked.txt"] = ("AccessDenied", "no")
    result = d.delete_objects(["ok.txt", "locked.txt"])
    assert result.deleted == ["ok.txt"]
    assert len(result.errors) == 1
    assert result.errors[0].key == "locked.txt"
    assert result.errors[0].code == "AccessDenied"
    assert result.errors[0].message == "no"


def test_delete_objects_quiet_omits_success_list(archil, s3, router):
    d = _disk(archil)
    result = d.delete_objects(["a", "b"], quiet=True)
    assert result.deleted == []
    assert result.errors == []
    delete_req = next(r for r in router.requests if r.method == "POST")
    assert "<Quiet>true</Quiet>" in delete_req.content.decode()


def test_delete_objects_batches_over_1000(archil, router):
    calls = {"posts": 0}

    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        if req.method == "POST" and "delete" in req.url.params:
            calls["posts"] += 1
            keys = re.findall(r"<Key>([^<]*)</Key>", req.content.decode())
            rows = "".join(f"<Deleted><Key>{k}</Key></Deleted>" for k in keys)
            return httpx.Response(200, content=f'<?xml version="1.0"?><DeleteResult>{rows}</DeleteResult>'.encode())
        return httpx.Response(405)

    router.set(handler)
    d = _disk(archil)
    keys = [f"k{i}" for i in range(2500)]
    result = d.delete_objects(keys)
    assert calls["posts"] == 3  # 1000 + 1000 + 500
    assert result.deleted == keys
