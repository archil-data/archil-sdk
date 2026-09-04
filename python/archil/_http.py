from __future__ import annotations

import asyncio
import random
import threading
import weakref
from dataclasses import dataclass
from typing import Any, Literal, Optional, Union
from urllib.parse import quote, urlsplit

import httpx

from ._version import USER_AGENT
from .errors import ArchilApiError

BodyType = Union[str, bytes, bytearray, memoryview]
_RetryMode = Literal["none", "connect", "transient"]


# Default request timeout (seconds) applied to every control-plane and S3 call.
# Override per-client via Archil(timeout=...). Without an explicit timeout a hung
# request would block forever — particularly painful since the synchronicity
# blocking interface runs the work on a background loop thread.
DEFAULT_TIMEOUT = 30.0

_MAX_RETRIES = 3
_RETRY_BASE_SECONDS = 0.1
_RETRY_CAP_SECONDS = 2.0
_TRANSIENT_STATUSES = frozenset({429, 500, 502, 503, 504})
_CONNECT_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)

_CONTROL_PLANE_LIMITS = httpx.Limits(
    max_connections=100,
    max_keepalive_connections=100,
    keepalive_expiry=600.0,
)


@dataclass
class _SharedClientEntry:
    client: httpx.AsyncClient
    references: int = 0


# Async HTTP clients are bound to the event loop on which they are used. Share
# one HTTP/2-capable control-plane client across Archil instances on the same
# loop, while keeping different credentials and origins isolated. Sync callers
# naturally converge on synchronicity's package-wide background loop.
_shared_cp_clients: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop,
    dict[tuple[str, str], _SharedClientEntry],
] = weakref.WeakKeyDictionary()
_shared_cp_clients_lock = threading.Lock()


def _retry_delay(attempt: int) -> float:
    ceiling = min(_RETRY_CAP_SECONDS, _RETRY_BASE_SECONDS * (2**attempt))
    return random.random() * ceiling


def _auth_header(api_key: str) -> str:
    # Mirror the control-plane REST convention: a single leading "key-" prefix.
    stripped = api_key[4:] if api_key.startswith("key-") else api_key
    return f"key-{stripped}"


def _origin(url: str) -> str:
    parsed = urlsplit(url)
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _acquire_shared_cp_client(
    base_url: str,
    headers: dict[str, str],
) -> tuple[httpx.AsyncClient, tuple[asyncio.AbstractEventLoop, tuple[str, str], _SharedClientEntry]]:
    loop = asyncio.get_running_loop()
    key = (_origin(base_url), headers["Authorization"])

    with _shared_cp_clients_lock:
        clients = _shared_cp_clients.setdefault(loop, {})
        entry = clients.get(key)
        if entry is None:
            entry = _SharedClientEntry(
                httpx.AsyncClient(
                    headers=headers,
                    http2=True,
                    limits=_CONTROL_PLANE_LIMITS,
                    timeout=None,
                )
            )
            clients[key] = entry
        entry.references += 1

    return entry.client, (loop, key, entry)


async def _release_shared_cp_client(
    handle: tuple[asyncio.AbstractEventLoop, tuple[str, str], _SharedClientEntry],
) -> None:
    loop, key, entry = handle
    should_close = False

    with _shared_cp_clients_lock:
        clients = _shared_cp_clients.get(loop)
        if clients is not None and clients.get(key) is entry:
            entry.references -= 1
            if entry.references == 0:
                del clients[key]
                if not clients:
                    del _shared_cp_clients[loop]
                should_close = True

    if should_close:
        await entry.client.aclose()


class _Transport:
    """Provides the HTTP clients for one ``Archil`` instance. Live control-plane
    clients share an HTTP/2 connection pool with matching clients on the same
    event loop; injected transports and S3 clients remain instance-local. Both
    APIs authenticate with the same API key (bearer), so the S3 object API needs
    no separate credentials or SigV4 signing on the caller's part.

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
        self._cp: Optional[httpx.AsyncClient] = None
        self._cp_pool_handle: Optional[
            tuple[asyncio.AbstractEventLoop, tuple[str, str], _SharedClientEntry]
        ] = None
        self._s3: Optional[httpx.AsyncClient] = None

    def _cp_client(self) -> httpx.AsyncClient:
        if self._cp is None:
            if self._transport is None:
                self._cp, self._cp_pool_handle = _acquire_shared_cp_client(
                    self._base_url,
                    self._headers,
                )
            else:
                self._cp = httpx.AsyncClient(
                    base_url=self._base_url,
                    headers=self._headers,
                    transport=self._transport,
                    timeout=self._timeout,
                )
        return self._cp

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

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json: Optional[Any] = None,
        retry: _RetryMode = "none",
    ) -> Any:
        """Send a control-plane request and unwrap the ``{success, data}`` envelope."""
        body = await self._request_envelope(method, path, params=params, json=json, retry=retry)
        return body.get("data")

    async def request_json_page(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        retry: _RetryMode = "none",
    ) -> tuple[Any, Optional[str]]:
        """Like :meth:`request_json`, but also return the envelope's
        ``nextCursor`` (``None`` on the last page or from a server that doesn't
        paginate)."""
        body = await self._request_envelope(method, path, params=params, json=None, retry=retry)
        return body.get("data"), body.get("nextCursor")

    async def request_empty(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json: Optional[Any] = None,
        retry: _RetryMode = "none",
    ) -> None:
        await self._request_envelope(method, path, params=params, json=json, allow_empty=True, retry=retry)

    async def _request_envelope(
        self,
        method,
        path,
        *,
        params,
        json,
        allow_empty: bool = False,
        retry: _RetryMode = "none",
    ) -> dict:
        # Drop None-valued query params so optional args don't serialize as "None".
        clean_params = {k: v for k, v in (params or {}).items() if v is not None} or None
        attempt = 0
        while True:
            try:
                client = self._cp_client()
                url = f"{self._base_url}{path}" if self._cp_pool_handle is not None else path
                resp = await client.request(
                    method,
                    url,
                    params=clean_params,
                    json=json,
                    timeout=self._timeout,
                )
            except _CONNECT_ERRORS:
                if retry == "none" or attempt >= _MAX_RETRIES:
                    raise
            except httpx.TransportError:
                if retry != "transient" or attempt >= _MAX_RETRIES:
                    raise
            else:
                if retry != "transient" or resp.status_code not in _TRANSIENT_STATUSES or attempt >= _MAX_RETRIES:
                    break
            await asyncio.sleep(_retry_delay(attempt))
            attempt += 1
        body: Optional[dict]
        try:
            body = resp.json()
        except ValueError:
            body = None
        if allow_empty and resp.is_success and body is None:
            return {}
        if not body or not body.get("success"):
            message = (body or {}).get("error") or f"API request failed with status {resp.status_code}"
            # Surface a machine-readable `code` when the control plane provides one
            # (consistent with ArchilS3Error.code), rather than always None.
            code = body.get("code") if body else None
            raise ArchilApiError(message, resp.status_code, code)
        return body

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
        max_retries = _MAX_RETRIES if retry else 0
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
                await asyncio.sleep(_retry_delay(attempt))
                continue
            if resp.status_code in _TRANSIENT_STATUSES and attempt < max_retries:
                # `client.request` is non-streaming: it has already read the body
                # in full and closed the response (resp.is_closed), so the
                # connection is back in the pool before we sleep — no explicit
                # aclose needed.
                await asyncio.sleep(_retry_delay(attempt))
                continue
            return resp
        # Unreachable: the final attempt either returns a response or re-raises.
        assert last_error is not None
        raise last_error

    async def aclose(self) -> None:
        if self._cp is not None:
            if self._cp_pool_handle is None:
                await self._cp.aclose()
            else:
                await _release_shared_cp_client(self._cp_pool_handle)
            self._cp = None
            self._cp_pool_handle = None
        if self._s3 is not None:
            await self._s3.aclose()
            self._s3 = None
