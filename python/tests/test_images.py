import json

import pytest

import archil._images as images_module
from archil import ImageBuildError, ImageData, RegistryAuth
from conftest import ok_envelope

NOW = "2026-09-25T12:00:00Z"
IMAGE_ID = "b" * 64
DIGEST = "sha256:" + "a" * 64


def image_json(status: str, **extra) -> dict:
    return {
        "image_id": IMAGE_ID,
        "source": "ghcr.io/acme/app:v1",
        "private": True,
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
        **extra,
    }


def sandbox_json(**extra) -> dict:
    return {
        "sandbox_id": "0198-sandbox",
        "name": "from-image",
        "status": "running",
        "vcpu_count": 1,
        "mem_size_mib": 2048,
        "max_ttl_seconds": 3600,
        "max_concurrent_execs": 32,
        "base_image": DIGEST,
        "created_at": NOW,
        "last_active_at": NOW,
        **extra,
    }


def test_create_sends_credentials_and_polls_until_ready(archil, router, monkeypatch):
    monkeypatch.setattr(images_module, "_POLL_INTERVAL_SECONDS", 0)
    polls = []

    def handler(request):
        if request.method == "POST":
            return ok_envelope(image_json("building"))
        polls.append(request.url.path)
        if len(polls) < 2:
            return ok_envelope(image_json("building"))
        return ok_envelope(image_json("ready", digest=DIGEST, canonical_source="ghcr.io/acme/app@sha256:" + "c" * 64))

    router.set(handler)
    image = archil.images.create(
        "ghcr.io/acme/app:v1", registry_auth=RegistryAuth(username="octocat", password="ghp_token")
    )

    assert image.status == "ready"
    assert image.digest == DIGEST
    assert image.canonical_source == "ghcr.io/acme/app@sha256:" + "c" * 64
    assert json.loads(router.requests[0].content) == {
        "source": "ghcr.io/acme/app:v1",
        "registry_auth": {"username": "octocat", "password": "ghp_token"},
    }
    assert [(r.method, r.path) for r in router.requests] == [
        ("POST", "/api/images"),
        ("GET", f"/api/images/{IMAGE_ID}"),
        ("GET", f"/api/images/{IMAGE_ID}"),
    ]


def test_create_raises_when_the_build_fails(archil, router):
    router.set(lambda request: ok_envelope(image_json("failed", failure_reason="image not found, or the registry denied access")))

    with pytest.raises(ImageBuildError, match="image not found, or the registry denied access") as raised:
        archil.images.create("ghcr.io/acme/missing:v1")
    assert raised.value.latest.status == "failed"


def test_create_can_return_without_waiting(archil, router):
    router.set(lambda request: ok_envelope(image_json("building")))

    image = archil.images.create("node:24", wait=False)

    assert image.status == "building"
    assert image.digest is None
    assert len(router.requests) == 1


def test_sandboxes_boot_a_ready_image_or_its_digest(archil, router):
    router.set(lambda request: ok_envelope(sandbox_json(image_digest=DIGEST)))
    ready = ImageData.from_json(image_json("ready", digest=DIGEST))

    sandbox = archil.sandboxes.create(image=ready)
    archil.sandboxes.create(image=DIGEST)

    assert sandbox.image_digest == DIGEST
    assert [json.loads(r.content)["image_digest"] for r in router.requests] == [DIGEST, DIGEST]
    with pytest.raises(ValueError, match="is building, not ready"):
        archil.sandboxes.create(image=ImageData.from_json(image_json("building")))


def test_registry_auth_repr_omits_the_password():
    assert "ghp_token" not in repr(RegistryAuth(username="octocat", password="ghp_token"))
