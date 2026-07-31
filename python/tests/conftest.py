from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable, Optional

import httpx
import pytest

from archil import Archil

CP_BASE = "http://cp.test"
S3_BASE = "http://s3.test"


@dataclass
class RecordedRequest:
    method: str
    path: str
    raw_path: str  # percent-encoded path+query as sent on the wire
    query: dict
    headers: dict
    content: bytes

    @property
    def json(self):
        return json.loads(self.content) if self.content else None


@dataclass
class Router:
    """Collects handlers and records every request the SDK makes so tests can
    assert on the exact wire calls (method, path, query, body, auth header)."""

    requests: list[RecordedRequest] = field(default_factory=list)
    _handler: Optional[Callable[[httpx.Request], httpx.Response]] = None

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            RecordedRequest(
                method=request.method,
                path=request.url.path,
                raw_path=request.url.raw_path.decode("ascii"),
                query=dict(request.url.params),
                headers=dict(request.headers),
                content=request.content,
            )
        )
        assert self._handler is not None, "no handler set on Router"
        return self._handler(request)

    def set(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self._handler = handler


def ok_envelope(data, next_cursor: Optional[str] = None) -> httpx.Response:
    body = {"success": True, "data": data}
    if next_cursor is not None:
        body["nextCursor"] = next_cursor
    return httpx.Response(200, json=body)


def error_envelope(status: int, message: str) -> httpx.Response:
    return httpx.Response(status, json={"success": False, "error": message})


def s3_error(status: int, code: str, message: str, request_id: str = "req-123") -> httpx.Response:
    body = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f"<Error><Code>{code}</Code><Message>{message}</Message>"
        f"<RequestId>{request_id}</RequestId></Error>"
    )
    return httpx.Response(status, content=body.encode(), headers={"content-type": "application/xml"})


@pytest.fixture
def router() -> Router:
    return Router()


@pytest.fixture
def archil(router: Router) -> Archil:
    return Archil(
        api_key="key-test",
        region="aws-us-east-1",
        base_url=CP_BASE,
        s3_base_url=S3_BASE,
        _http_transport=httpx.MockTransport(router.handle),
    )
