import pytest

from archil import Archil
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


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.delenv("ARCHIL_API_KEY", raising=False)
    with pytest.raises(ValueError, match="API key"):
        Archil(region="aws-us-east-1")


def test_missing_region_raises(monkeypatch):
    monkeypatch.delenv("ARCHIL_REGION", raising=False)
    with pytest.raises(ValueError, match="region"):
        Archil(api_key="key-test")


def test_s3_request_without_base_url_raises():
    import asyncio

    from archil._http import _Transport

    transport = _Transport("http://cp.test", "key-test", None)
    with pytest.raises(ValueError, match="S3 base URL not configured"):
        asyncio.run(transport.s3_request("GET", "dsk-1", "k"))


def test_configure_closes_previous_instance(monkeypatch):
    import archil as archil_mod

    closed = {"count": 0}

    class FakeArchil:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def close(self):
            closed["count"] += 1

    monkeypatch.setattr(archil_mod, "Archil", FakeArchil)
    # Reset module state and restore it afterward so other tests are unaffected.
    monkeypatch.setattr(archil_mod, "_instance", None)
    monkeypatch.setattr(archil_mod, "_options", None)

    archil_mod.configure(api_key="k1", region="aws-us-east-1")
    archil_mod._client()  # materialize the first instance
    archil_mod.configure(api_key="k2", region="aws-us-east-1")  # must close the first
    assert closed["count"] == 1


def test_client_lazy_init_is_thread_safe(monkeypatch):
    import threading
    import time

    import archil as archil_mod

    constructed = []

    class FakeArchil:
        def __init__(self, **kwargs):
            time.sleep(0.01)  # widen the race window
            constructed.append(self)

    monkeypatch.setattr(archil_mod, "Archil", FakeArchil)
    monkeypatch.setattr(archil_mod, "_instance", None)
    monkeypatch.setattr(archil_mod, "_options", {})

    barrier = threading.Barrier(8)
    results = []

    def worker():
        barrier.wait()
        results.append(archil_mod._client())

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Exactly one client constructed, and every thread got the same instance.
    assert len(constructed) == 1
    assert len({id(r) for r in results}) == 1


def test_sync_context_manager(router, archil):
    router.set(lambda req: ok_envelope(DISK_JSON))
    with archil as client:
        d = client.disks.get("dsk-1")
        assert d.id == "dsk-1"


def test_control_plane_request_sends_python_user_agent(router, archil):
    router.set(lambda req: ok_envelope([]))
    archil.disks.list()
    # Distinct from the JS SDK so the control plane can tell the clients apart,
    # and carries the package version.
    ua = router.requests[0].headers["user-agent"]
    assert ua.startswith("archil-python/")
    assert "httpx" not in ua  # our UA replaced httpx's default
