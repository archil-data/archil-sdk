from datetime import datetime, timezone

import httpx
import pytest

from archil import Image, ImageBuildError, RegistryAuth
from conftest import ok_envelope

NOW = "2026-10-01T12:00:00Z"
IMAGE_ID = "a" * 64
SOURCE = "ghcr.io/acme/app:v1"
AUTH = RegistryAuth(username="bot", password="registry-secret")
AUTH_JSON = {"username": "bot", "password": "registry-secret"}


def image_json(status: str, **overrides) -> dict:
    return {
        "image_id": IMAGE_ID,
        "source": SOURCE,
        "private": True,
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
        **overrides,
    }


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(monkeypatch) -> FakeClock:
    import archil._images as images_module

    clock = FakeClock()
    monkeypatch.setattr(images_module, "time", clock)
    monkeypatch.setattr(images_module, "asyncio", clock)
    return clock


def respond(router, clock: FakeClock, *images: dict) -> list[tuple[str, float]]:
    """Answer every request with the next image; the last one repeats."""
    calls: list[tuple[str, float]] = []
    remaining = list(images)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, clock.now))
        return ok_envelope(remaining.pop(0) if len(remaining) > 1 else remaining[0])

    router.set(handler)
    return calls


def test_build_retries_transient_failure_and_returns_ready_image(archil, router, monkeypatch):
    import archil._http as http_module

    monkeypatch.setattr(http_module, "_retry_delay", lambda _attempt: 0)
    responses = [
        httpx.Response(503, json={"success": False, "error": "no runtime host available", "code": "no_capacity"}),
        httpx.Response(
            202,
            json={
                "success": True,
                "data": image_json("ready", digest="sha256:abc", canonical_source="ghcr.io/acme/app@sha256:abc"),
            },
        ),
    ]
    router.set(lambda _request: responses.pop(0))

    image = archil.images.build(source=SOURCE, registry_auth=AUTH)

    assert image == Image(
        image_id=IMAGE_ID,
        source=SOURCE,
        private=True,
        status="ready",
        created_at=datetime(2026, 10, 1, 12, tzinfo=timezone.utc),
        updated_at=datetime(2026, 10, 1, 12, tzinfo=timezone.utc),
        digest="sha256:abc",
        canonical_source="ghcr.io/acme/app@sha256:abc",
    )
    assert [(r.method, r.path, r.json) for r in router.requests] == [
        ("POST", "/api/images", {"source": SOURCE, "registry_auth": AUTH_JSON})
    ] * 2


@pytest.mark.asyncio
async def test_build_polls_running_build_with_backoff(archil, router, clock):
    calls = respond(router, clock, image_json("building"), image_json("building"), image_json("ready"))

    image = await archil.images.build.aio(source=SOURCE)

    assert image.status == "ready"
    assert calls == [("POST", 0.0), ("GET", 1.0), ("GET", 3.0)]
    assert router.requests[0].json == {"source": SOURCE}
    assert router.requests[1].path == f"/api/images/{IMAGE_ID}"


def test_build_requests_interrupted_build_again_with_credentials(archil, router, clock):
    respond(router, clock, image_json("failed", failure_reason="interrupted"), image_json("ready"))

    assert archil.images.build(source=SOURCE, registry_auth=AUTH).status == "ready"
    assert [(r.method, r.json) for r in router.requests] == [
        ("POST", {"source": SOURCE, "registry_auth": AUTH_JSON})
    ] * 2


@pytest.mark.parametrize(("reason", "requests"), [("invalid_source", 1), ("interrupted", 4)])
def test_build_raises_failure_reason(archil, router, clock, reason, requests):
    calls = respond(router, clock, image_json("failed", failure_reason=reason))

    with pytest.raises(ImageBuildError) as caught:
        archil.images.build(source=SOURCE)

    assert caught.value.reason == reason
    assert caught.value.code == "IMAGE_BUILD_FAILED"
    assert caught.value.latest.image_id == IMAGE_ID
    assert [method for method, _ in calls] == ["POST"] * requests


def test_build_requests_long_running_build_again_every_two_minutes(archil, router, clock):
    calls = respond(router, clock, image_json("building"))

    with pytest.raises(TimeoutError):
        archil.images.build(source=SOURCE, timeout=125)

    assert [at for method, at in calls if method == "POST"] == [0.0, 122.0]


def test_build_times_out(archil, router, clock):
    calls = respond(router, clock, image_json("building"))

    with pytest.raises(TimeoutError, match=IMAGE_ID):
        archil.images.build(source=SOURCE, timeout=10)

    assert [at for _, at in calls] == [0.0, 1.0, 3.0, 7.0, 12.0]


def test_registry_password_is_hidden():
    assert "registry-secret" not in repr(AUTH)
    assert "registry-secret" not in str(AUTH)
