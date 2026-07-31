import hashlib

import httpx
import pytest

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


def _store_handler():
    objects: dict[str, bytes] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "cp.test":
            return ok_envelope(DISK_JSON)
        from urllib.parse import unquote

        key = unquote(req.url.path[len("/dsk-1") :].lstrip("/"))
        if req.method == "PUT":
            objects[key] = req.content
            return httpx.Response(200, headers={"etag": '"' + hashlib.md5(req.content).hexdigest() + '"'})
        if req.method == "GET" and key == "":
            keys = sorted(objects)
            body = "<ListBucketResult><IsTruncated>false</IsTruncated>" + "".join(
                f"<Contents><Key>{k}</Key><Size>{len(objects[k])}</Size></Contents>" for k in keys
            ) + "</ListBucketResult>"
            return httpx.Response(200, content=body.encode())
        if req.method == "GET":
            return httpx.Response(200, content=objects[key])
        return httpx.Response(204)

    return handler


@pytest.mark.asyncio
async def test_aio_roundtrip(router, archil):
    router.set(_store_handler())
    d = await archil.disks.get.aio("dsk-1")
    assert d.id == "dsk-1"
    res = await d.put_object.aio("a/b.txt", b"async-bytes")
    assert res.etag.startswith('"')
    got = await d.get_object.aio("a/b.txt")
    assert got == b"async-bytes"


@pytest.mark.asyncio
async def test_aio_async_generator(router, archil):
    router.set(_store_handler())
    d = await archil.disks.get.aio("dsk-1")
    for k in ["p/1", "p/2"]:
        await d.put_object.aio(k, k.encode())
    keys = []
    async for page in d.list_objects_pages.aio("p/", recursive=True):
        keys.extend(o.key for o in page.objects)
    assert keys == ["p/1", "p/2"]


@pytest.mark.asyncio
async def test_async_context_manager(router):
    from archil import Archil

    async with Archil(
        api_key="key-test",
        region="aws-us-east-1",
        base_url="http://cp.test",
        s3_base_url="http://s3.test",
        _http_transport=httpx.MockTransport(_store_handler()),
    ) as client:
        d = await client.disks.get.aio("dsk-1")
        assert d.id == "dsk-1"
