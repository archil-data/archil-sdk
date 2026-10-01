from __future__ import annotations

import asyncio
import time
from dataclasses import asdict
from typing import Optional

from ._http import _Transport
from ._models import Image, RegistryAuth
from .errors import ImageBuildError

_DEFAULT_BUILD_TIMEOUT_SECONDS = 30 * 60.0
_MAX_INTERRUPTED_RETRIES = 3
_REQUEST_AGAIN_SECONDS = 120.0
_FIRST_POLL_SECONDS = 1.0
_MAX_POLL_SECONDS = 5.0


class _Images:
    """Account-level sandbox images built from OCI references."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def get(self, image_id: str) -> Image:
        data = await self._transport.request_json("GET", f"/api/images/{image_id}", retry="transient")
        return Image.from_json(data)

    async def build(
        self,
        *,
        source: str,
        registry_auth: Optional[RegistryAuth] = None,
        timeout: float = _DEFAULT_BUILD_TIMEOUT_SECONDS,
    ) -> Image:
        """Build a sandbox image from an OCI reference and wait until it is ready.

        Returns at once when the image is already built from a digest reference
        and joins a build that is already running. A tag is rebuilt on each
        call in case it moved, so call this once and reuse ``image_id``.
        ``registry_auth`` is required for private images on every call; without
        it ``source`` names the public image. Interrupted builds are requested
        again up to three times; other failures raise ``ImageBuildError``, and
        ``TimeoutError`` is raised if the image is not ready within ``timeout``
        seconds."""
        body: dict = {"source": source}
        if registry_auth is not None:
            body["registry_auth"] = asdict(registry_auth)
        deadline = time.monotonic() + timeout
        image = await self._request(body)
        last_request = time.monotonic()
        retries = 0
        poll = _FIRST_POLL_SECONDS
        while True:
            if image.status == "ready":
                return image
            if image.status == "failed":
                if image.failure_reason != "interrupted" or retries >= _MAX_INTERRUPTED_RETRIES:
                    raise ImageBuildError(image)
                retries += 1
                image = await self._request(body)
                last_request = time.monotonic()
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Image {image.image_id} was not ready after {timeout}s")
            await asyncio.sleep(poll)
            poll = min(poll * 2, _MAX_POLL_SECONDS)
            # Requesting again joins a healthy build and restarts one whose runtime host is gone.
            if time.monotonic() - last_request >= _REQUEST_AGAIN_SECONDS:
                image = await self._request(body)
                last_request = time.monotonic()
            else:
                image = await self.get(image.image_id)

    async def _request(self, body: dict) -> Image:
        data = await self._transport.request_json("POST", "/api/images", json=body, retry="transient")
        return Image.from_json(data)
