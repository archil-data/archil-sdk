from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Optional

from ._http import _Transport
from ._models import ImageData, RegistryAuth
from .errors import ImageBuildError

_POLL_INTERVAL_SECONDS = 1.0


class _Images:
    """Sandbox images built from public or private registries."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def create(
        self,
        source: str,
        *,
        registry_auth: Optional[RegistryAuth] = None,
        wait: bool = True,
    ) -> ImageData:
        """Build an image that sandboxes can boot. Requesting a source that is
        already building joins that build. By default this waits until the image
        is ready and raises ``ImageBuildError`` if the build fails."""
        body: dict = {"source": source}
        if registry_auth is not None:
            body["registry_auth"] = asdict(registry_auth)
        data = await self._transport.request_json("POST", "/api/images", json=body, retry="transient")
        image = ImageData.from_json(data)
        return await self._wait_for_build(image) if wait else image

    async def get(self, id: str) -> ImageData:
        data = await self._transport.request_json("GET", f"/api/images/{id}", retry="transient")
        return ImageData.from_json(data)

    async def _wait_for_build(self, image: ImageData) -> ImageData:
        while image.status == "building":
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)
            image = await self.get(image.id)
        if image.status == "failed":
            raise ImageBuildError(image)
        return image
