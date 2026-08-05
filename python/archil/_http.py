from __future__ import annotations

import asyncio
import random
from typing import Optional, TypeVar, Union
from urllib.parse import quote

import httpx
from archil_openapi import AuthenticatedClient
from archil_openapi.models.error_response import ErrorResponse
from archil_openapi.types import Response, Unset

from ._version import USER_AGENT
from .errors import ArchilApiError

BodyType = Union[str, bytes, bytearray, memoryview]
ResponseType = TypeVar("ResponseType")


# Default request timeout (seconds) applied to every control-plane and S3 call.
# Override per-client via Archil(timeout=...). Without an explicit timeout a hung
# request would block forever — particularly painful since the synchronicity
# blocking interface runs the work on a background loop thread.
DEFAULT_TIMEOUT = 30.0

# Automatic retries for a transient S3 failure (5xx / 429 / network error).
_MAX_S3_RETRIES = 3
# Base backoff (seconds); grows exponentially, then full-jittered.
_S3_RETRY_BASE_SECONDS = 0.1
# Ceiling for a single retry backoff (seconds).
_S3_RETRY_CAP_SECONDS = 2.0
# Throttling (429) and the gateway's transient 5xx (e.g. a journal-commit
# timeout surfaced as 500). 4xx other than 429 are caller errors, never retried.
_TRANSIENT_S3_STATUSES = frozenset({429, 500, 502, 503, 504})


def _s3_retry_delay(attempt: int) -> float:
    """Full-jittered exponential backoff for retry ``attempt`` (0-based)."""
    ceiling = min(_S3_RETRY_CAP_SECONDS, _S3_RETRY_BASE_SECONDS * (2**attempt))
    return random.random() * ceiling


def _auth_header(api_key: str) -> str:
    # Mirror the control-plane REST convention: a single leading "key-" prefix.
    stripped = api_key[4:] if api_key.startswith("key-") else api_key
    return f"key-{stripped}"


class _Transport:
    """Owns the HTTP clients for one ``Archil`` instance: the control-plane REST
    client and the S3-compatible gateway client. Both authenticate with the same
    API key (bearer), so the S3 object API needs no separate credentials or SigV4
    signing on the caller's part.

    httpx clients are created lazily on first use so they bind to the
    synchronizer's event loop rather than whatever loop happened to exist at
    construction time."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        s3_base_url: Optional[str],
        transport: Optional[httpx.AsyncBaseTransport] = None,
        timeout: Optional[float] = DEFAULT_TIMEOUT,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._s3_base_url = (s3_base_url or "").rstrip("/")
        self._headers = {"Authorization": _auth_header(api_key), "User-Agent": USER_AGENT}
        # An injected transport (tests use httpx.MockTransport) routes requests
        # without a live server while still exercising the real client stack.
        self._transport = transport
        self._timeout = timeout
        self.openapi = AuthenticatedClient(
            base_url=self._base_url,
            token=_auth_header(api_key),
            prefix="",
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
            httpx_args={"transport": transport},
        )
        self._s3: Optional[httpx.AsyncClient] = None

    def _s3_client(self) -> httpx.AsyncClient:
        if not self._s3_base_url:
            raise ValueError(
                "S3 base URL not configured. Pass s3_base_url to Archil(...) or set "
                "ARCHIL_S3_BASE_URL."
            )
        if self._s3 is None:
            self._s3 = httpx.AsyncClient(
                base_url=self._s3_base_url,
                headers=self._headers,
                transport=self._transport,
                timeout=self._timeout,
            )
        return self._s3

    def unwrap(self, response: Response[Union[ErrorResponse, ResponseType]]) -> ResponseType:
        parsed = response.parsed
        if isinstance(parsed, ErrorResponse):
            code = None if isinstance(parsed.code, Unset) else parsed.code
            raise ArchilApiError(parsed.error, response.status_code, code)
        if parsed is None:
            raise ArchilApiError(
                f"API request failed with status {response.status_code}", response.status_code
            )
        return parsed

    async def s3_request(
        self,
        method: str,
        disk_id: str,
        key: str,
        *,
        body: Optional[BodyType] = None,
        content_type: Optional[str] = None,
        params: Optional[dict] = None,
        retry: bool = True,
        extra_headers: Optional[dict[str, str]] = None,
    ) -> httpx.Response:
        """Send a single request to the disk's S3-compatible endpoint and return
        the raw response (status, headers, and fully-buffered content) so callers
        inspect both regardless of verb. An empty ``key`` targets the bucket
        itself (used by list_objects).

        Transient failures are retried unless ``retry=False`` — set that for
        non-idempotent ops (CompleteMultipartUpload), where a retry after a
        successful-but-unacknowledged completion returns a spurious NoSuchUpload."""
        client = self._s3_client()

        # Percent-encode each key segment so reserved characters (?, #, %, space,
        # …) can't be reinterpreted, while preserving the "/" separators that
        # model the key's directory structure.
        trimmed = key.lstrip("/")
        encoded = "/".join(quote(segment, safe="") for segment in trimmed.split("/")) if trimmed else ""
        path = f"/{disk_id}/{encoded}" if encoded else f"/{disk_id}"

        headers: Optional[dict[str, str]] = None
        if content_type or extra_headers:
            headers = {}
            if content_type:
                headers["Content-Type"] = content_type
            if extra_headers:
                headers.update(extra_headers)
        content: Optional[bytes] = None
        if body is not None:
            content = body.encode("utf-8") if isinstance(body, str) else bytes(body)

        # Retry transient failures (gateway 5xx / 429 / network errors) with
        # jittered exponential backoff. Bodies are buffered, so re-sending is
        # safe. Every op is safe to retry EXCEPT CompleteMultipartUpload, which
        # passes retry=False (see the docstring).
        max_retries = _MAX_S3_RETRIES if retry else 0
        last_error: Optional[httpx.TransportError] = None
        for attempt in range(max_retries + 1):
            try:
                resp = await client.request(
                    method, path, params=params, content=content, headers=headers
                )
            except httpx.TransportError as exc:
                last_error = exc
                if attempt >= max_retries:
                    raise
                await asyncio.sleep(_s3_retry_delay(attempt))
                continue
            if resp.status_code in _TRANSIENT_S3_STATUSES and attempt < max_retries:
                # `client.request` is non-streaming: it has already read the body
                # in full and closed the response (resp.is_closed), so the
                # connection is back in the pool before we sleep — no explicit
                # aclose needed.
                await asyncio.sleep(_s3_retry_delay(attempt))
                continue
            return resp
        # Unreachable: the final attempt either returns a response or re-raises.
        assert last_error is not None
        raise last_error

    async def aclose(self) -> None:
        await self.openapi.get_async_httpx_client().aclose()
        if self._s3 is not None:
            await self._s3.aclose()
            self._s3 = None
