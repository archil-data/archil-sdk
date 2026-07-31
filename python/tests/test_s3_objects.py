import hashlib
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


class MockS3:
    """A minimal in-memory S3-compatible store routed by the MockTransport. Small
    page size forces ListObjectsV2 continuation so the SDK's pagination is
    actually exercised."""

    def __init__(self, page_size: int = 2):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.page_size = page_size

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)

        # Path is /dsk-1[/<encoded key>]; decode back to the real key.
        rel = req.url.path[len("/dsk-1") :].lstrip("/")
        key = unquote(rel)

        if req.method == "PUT":
            ctype = req.headers.get("content-type", "application/octet-stream")
            if "append" in req.url.params:
                existing = self.objects.get(key, (b"", ctype))[0]
                merged = existing + req.content
                self.objects[key] = (merged, ctype)
                return httpx.Response(200, headers={"etag": self._etag(merged)})
            self.objects[key] = (req.content, ctype)
            etag = self._etag(req.content)
            return httpx.Response(200, headers={"etag": etag})

        if req.method == "GET" and rel == "":
            return self._list(req)

        if req.method == "GET":
            if key not in self.objects:
                return s3_error(404, "NoSuchKey", "The specified key does not exist.")
            body, ctype = self.objects[key]
            return httpx.Response(200, content=body, headers={"content-type": ctype, "etag": self._etag(body)})

        if req.method == "HEAD":
            if key not in self.objects:
                return httpx.Response(404)
            body, ctype = self.objects[key]
            return httpx.Response(
                200,
                headers={
                    "content-length": str(len(body)),
                    "content-type": ctype,
                    "etag": self._etag(body),
                    "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
                },
            )

        if req.method == "DELETE":
            self.objects.pop(key, None)
            return httpx.Response(204)

        return httpx.Response(405)

    @staticmethod
    def _etag(body: bytes) -> str:
        return '"' + hashlib.md5(body).hexdigest() + '"'

    def _list(self, req: httpx.Request) -> httpx.Response:
        params = req.url.params
        prefix = params.get("prefix", "")
        delimiter = params.get("delimiter")
        start_after = params.get("start-after")
        token = params.get("continuation-token")
        offset = int(token) if token else 0

        keys = sorted(k for k in self.objects if k.startswith(prefix))
        if start_after:
            keys = [k for k in keys if k > start_after]

        contents_keys: list[str] = []
        common: set[str] = set()
        if delimiter:
            for k in keys:
                rest = k[len(prefix) :]
                if delimiter in rest:
                    common.add(prefix + rest.split(delimiter, 1)[0] + delimiter)
                else:
                    contents_keys.append(k)
        else:
            contents_keys = keys

        page = contents_keys[offset : offset + self.page_size]
        truncated = offset + self.page_size < len(contents_keys)
        next_token = str(offset + self.page_size) if truncated else None

        parts = ['<?xml version="1.0" encoding="UTF-8"?>', "<ListBucketResult>"]
        parts.append(f"<Prefix>{prefix}</Prefix>")
        parts.append(f"<KeyCount>{len(page)}</KeyCount>")
        parts.append(f"<IsTruncated>{'true' if truncated else 'false'}</IsTruncated>")
        if next_token:
            parts.append(f"<NextContinuationToken>{next_token}</NextContinuationToken>")
        for k in page:
            body, _ = self.objects[k]
            parts.append(f"<Contents><Key>{k}</Key><Size>{len(body)}</Size><ETag>{self._etag(body)}</ETag></Contents>")
        for cp in sorted(common):
            parts.append(f"<CommonPrefixes><Prefix>{cp}</Prefix></CommonPrefixes>")
        parts.append("</ListBucketResult>")
        return httpx.Response(200, content="".join(parts).encode())


@pytest.fixture
def s3(router):
    store = MockS3()
    router.set(store)
    return store


def _disk(archil):
    return archil.disks.get("dsk-1")


def test_put_get_head_roundtrip(archil, s3):
    d = _disk(archil)
    res = d.put_object("a/hello.txt", b"hello world", "text/plain")
    assert res.etag == MockS3._etag(b"hello world")
    assert d.get_object("a/hello.txt") == b"hello world"

    meta = d.head_object("a/hello.txt")
    assert meta is not None
    assert meta.size == 11
    assert meta.content_type == "text/plain"
    assert meta.etag == res.etag
    assert meta.last_modified is not None
    assert d.object_exists("a/hello.txt") is True


def test_put_accepts_str_and_bytes(archil, s3):
    d = _disk(archil)
    d.put_object("s.txt", "a string")
    assert d.get_object("s.txt") == b"a string"


def test_put_sends_posix_create_headers(archil, s3, router):
    d = _disk(archil)
    d.put_object("posix.txt", b"hi", mode=0o640, uid=1000, gid=1000)
    put = next(r for r in router.requests if r.method == "PUT")
    # httpx lower-cases header names in the recorded dict.
    assert put.headers.get("x-archil-mode") == "640"
    assert put.headers.get("x-archil-uid") == "1000"
    assert put.headers.get("x-archil-gid") == "1000"


def test_put_content_type_is_optional(archil, s3, router):
    d = _disk(archil)
    # Omitted → no Content-Type header is sent (the gateway picks the default).
    d.put_object("no-ct.txt", b"x")
    put_no_ct = next(r for r in router.requests if r.method == "PUT")
    assert "content-type" not in {k.lower() for k in put_no_ct.headers}
    # Provided → the header is sent verbatim.
    d.put_object("with-ct.txt", b"x", "application/json")
    put_with_ct = [r for r in router.requests if r.method == "PUT"][-1]
    assert put_with_ct.headers.get("content-type") == "application/json"


def test_get_missing_raises_structured_404(archil, s3):
    d = _disk(archil)
    with pytest.raises(ArchilS3Error) as exc:
        d.get_object("nope")
    assert exc.value.status == 404
    assert exc.value.code == "NoSuchKey"
    assert exc.value.request_id == "req-123"
    assert "NoSuchKey" in str(exc.value)


def test_head_missing_returns_none(archil, s3):
    d = _disk(archil)
    assert d.head_object("nope") is None
    assert d.object_exists("nope") is False


@pytest.mark.parametrize("cl", [None, "", "not-a-number"])
def test_head_object_tolerates_bad_content_length(archil, router, cl):
    # A missing/empty/garbage Content-Length must degrade to size 0, not raise
    # a bare ValueError out of the SDK.
    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        headers = {"etag": '"x"'}
        if cl is not None:
            headers["content-length"] = cl
        return httpx.Response(200, headers=headers)

    router.set(handler)
    meta = _disk(archil).head_object("k")
    assert meta is not None
    assert meta.size == 0


def test_append_object_creates_then_appends(archil, s3, router):
    d = _disk(archil)
    # First append to a missing key creates it.
    d.append_object("log.txt", b"line1\n")
    assert d.get_object("log.txt") == b"line1\n"
    # Subsequent appends concatenate; the returned etag is of the full object.
    res = d.append_object("log.txt", b"line2\n")
    assert d.get_object("log.txt") == b"line1\nline2\n"
    assert res.etag == MockS3._etag(b"line1\nline2\n")
    # The append requests are routed as PUT ?append=true.
    append_req = next(r for r in router.requests if r.method == "PUT")
    assert append_req.query.get("append") == "true"


def test_delete_then_gone_and_idempotent(archil, s3):
    d = _disk(archil)
    d.put_object("k", b"x")
    d.delete_object("k")
    assert d.object_exists("k") is False
    # Deleting a missing key is idempotent (no raise).
    d.delete_object("k")


def test_reserved_chars_in_key_roundtrip(archil, s3, router):
    d = _disk(archil)
    tricky = "p/100% (done) +final?.txt"
    d.put_object(tricky, b"reserved")
    assert d.get_object(tricky) == b"reserved"
    # The wire path must be percent-encoded — no raw space/%/? leaking through.
    # (A bare "?" would otherwise start the query string and truncate the key;
    # the successful round-trip above already proves it was encoded.)
    put_path = next(r.raw_path for r in router.requests if r.method == "PUT")
    assert " " not in put_path
    assert "%20" in put_path and "%25" in put_path and "%3F" in put_path.upper()
    # The "/" separators in the key are preserved (encoded per segment).
    assert "/dsk-1/p/" in put_path


def test_list_objects_autopaginates(archil, s3):
    d = _disk(archil)
    for k in ["p/1.txt", "p/2.txt", "p/3.txt"]:
        d.put_object(k, k.encode())
    result = d.list_objects("p/", recursive=True)
    assert [o.key for o in result.objects] == ["p/1.txt", "p/2.txt", "p/3.txt"]
    assert result.is_truncated is False  # full listing, despite 2-per-page paging
    assert result.key_count == 3


def test_list_objects_limit_truncates(archil, s3):
    d = _disk(archil)
    for k in ["p/1.txt", "p/2.txt", "p/3.txt"]:
        d.put_object(k, k.encode())
    result = d.list_objects("p/", recursive=True, limit=2)
    assert len(result.objects) == 2
    assert result.is_truncated is True


def test_list_objects_delimiter_rolls_up_prefixes(archil, s3):
    d = _disk(archil)
    d.put_object("top.txt", b"x")
    d.put_object("sub/a.txt", b"x")
    result = d.list_objects("")  # non-recursive default: delimiter "/"
    assert "top.txt" in [o.key for o in result.objects]
    assert "sub/" in result.common_prefixes


def test_list_objects_malformed_xml_raises_structured_error(archil, router):
    # A 200 response with a non-XML body must surface as ArchilS3Error, not a
    # bare xml ParseError leaking out of the SDK.
    def handler(req):
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        return httpx.Response(200, content=b"<<< not valid xml")

    router.set(handler)
    d = _disk(archil)
    with pytest.raises(ArchilS3Error) as exc:
        d.list_objects("p/")
    assert "ListObjectsV2" in str(exc.value)
    assert exc.value.raw == "<<< not valid xml"


def test_list_objects_pages_streams(archil, s3):
    d = _disk(archil)
    for k in ["p/1.txt", "p/2.txt", "p/3.txt"]:
        d.put_object(k, k.encode())
    keys = []
    pages = 0
    for page in d.list_objects_pages("p/", recursive=True):
        pages += 1
        keys.extend(o.key for o in page.objects)
    assert keys == ["p/1.txt", "p/2.txt", "p/3.txt"]
    assert pages == 2  # page_size=2 over 3 objects
