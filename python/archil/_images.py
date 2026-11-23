from __future__ import annotations

import asyncio
import os
import time
from dataclasses import asdict
from typing import Optional, Union

from ._build_context import upload_context
from ._http import _Transport
from ._models import Image, RegistryAuth
from .errors import ImageBuildError

_DEFAULT_BUILD_TIMEOUT_SECONDS = 30 * 60.0
_MAX_INTERRUPTED_RETRIES = 3
_REQUEST_AGAIN_SECONDS = 120.0
_FIRST_POLL_SECONDS = 1.0
_MAX_POLL_SECONDS = 5.0


class _Images:
    """Account-level sandbox images built from OCI references or Dockerfiles."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def get(self, image_id: str) -> Image:
        data = await self._transport.request_json("GET", f"/api/images/{image_id}", retry="transient")
        return Image.from_json(data)

    async def build(
        self,
        *,
        source: Optional[str] = None,
        dockerfile: Optional[str] = None,
        context: Optional[Union[str, os.PathLike]] = None,
        registry_auth: Optional[RegistryAuth] = None,
        vcpu_count: Optional[int] = None,
        mem_size_mib: Optional[int] = None,
        timeout: float = _DEFAULT_BUILD_TIMEOUT_SECONDS,
    ) -> Image:
        """Build a sandbox image from an OCI reference (``source``) or from the
        text of a Dockerfile (``dockerfile``), and wait until it is ready.

        Returns at once when the image is already built from a digest reference
        or the same Dockerfile and context, and joins a build that is already
        running. A tag is rebuilt on each call in case it moved, so call this
        once and reuse ``image_id``. ``registry_auth`` is required for private
        images on every call; without it ``source`` names the public image.
        ``context`` is a local directory that ``COPY`` and ``ADD`` read from: it
        is packed without the paths its ``.dockerignore`` excludes and uploaded
        unless the same files were uploaded before. ``vcpu_count`` and
        ``mem_size_mib`` (default 1 and 2048) are the size the build prepares
        sandboxes to start at from a snapshot; each size of a source is its own
        image, and a sandbox created from it at another size boots cold.
        Interrupted builds are requested again up to three times; other
        failures raise ``ImageBuildError``, whose message ends with a failed
        Dockerfile build's output, and ``TimeoutError`` is raised if the image
        is not ready within ``timeout`` seconds."""
        if (source is None) == (dockerfile is None):
            raise ValueError("Pass either source or dockerfile")
        if context is not None and dockerfile is None:
            raise ValueError("context applies only to a dockerfile build")
        if registry_auth is not None and source is None:
            raise ValueError("registry_auth applies only to a source build")
        body: dict = {"source": source} if source is not None else {"dockerfile": dockerfile}
        if context is not None:
            body["context"] = await upload_context(self._transport, context)
        if registry_auth is not None:
            body["registry_auth"] = asdict(registry_auth)
        if vcpu_count is not None:
            body["vcpu_count"] = vcpu_count
        if mem_size_mib is not None:
            body["mem_size_mib"] = mem_size_mib
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
            image = await self.get(image.image_id)
            # Requesting a still-building image again joins a healthy build and restarts one whose runtime host is gone.
            if image.status == "building" and time.monotonic() - last_request >= _REQUEST_AGAIN_SECONDS:
                image = await self._request(body)
                last_request = time.monotonic()

    async def _request(self, body: dict) -> Image:
        data = await self._transport.request_json("POST", "/api/images", json=body, retry="transient")
        return Image.from_json(data)
