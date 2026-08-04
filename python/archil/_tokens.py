from __future__ import annotations

from typing import Optional

from archil_openapi.api.api_tokens import create_api_token, delete_api_token, list_api_tokens
from archil_openapi.models.api_response_token_created_data import ApiResponseTokenCreatedData
from archil_openapi.models.api_token_response import ApiTokenResponse
from archil_openapi.models.create_api_token_request import CreateApiTokenRequest
from archil_openapi.types import UNSET

from ._http import _Transport


class _Tokens:
    """Account-level API keys (the control-plane credentials), distinct from
    per-disk mount tokens.

    Every method is available both synchronously and asynchronously — call it
    directly to block, or use ``.aio`` for a coroutine
    (e.g. ``await archil.tokens.list.aio()``)."""

    def __init__(self, transport: _Transport) -> None:
        self._transport = transport

    async def list(
        self, *, limit: Optional[int] = None, cursor: Optional[str] = None
    ) -> list[ApiTokenResponse]:
        response = self._transport.unwrap(
            await list_api_tokens.asyncio_detailed(
                client=self._transport.openapi,
                limit=UNSET if limit is None else limit,
                cursor=UNSET if cursor is None else cursor,
            )
        )
        return response.data.tokens

    async def create(
        self, *, name: str, description: Optional[str] = None
    ) -> ApiResponseTokenCreatedData:
        response = self._transport.unwrap(
            await create_api_token.asyncio_detailed(
                client=self._transport.openapi,
                body=CreateApiTokenRequest(
                    name=name,
                    description=UNSET if description is None else description,
                ),
            )
        )
        return response.data

    async def delete(self, id: str) -> None:
        self._transport.unwrap(
            await delete_api_token.asyncio_detailed(id, client=self._transport.openapi)
        )
