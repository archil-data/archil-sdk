from http import HTTPStatus
from typing import Any, Optional, Union
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_sandbox_exec import ApiResponseSandboxExec
from ...models.error_response import ErrorResponse
from ...types import Response


def _get_kwargs(
    sid: UUID,
    eid: UUID,
) -> dict[str, Any]:
    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": f"/api/sandboxes/{sid}/execs/{eid}/cancel",
    }

    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseSandboxExec, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseSandboxExec.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = ErrorResponse.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = ErrorResponse.from_dict(response.json())

        return response_404

    if response.status_code == 500:
        response_500 = ErrorResponse.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Response[Union[ApiResponseSandboxExec, ErrorResponse]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sid: UUID,
    eid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Response[Union[ApiResponseSandboxExec, ErrorResponse]]:
    """Cancel a running exec

     Aborts a running exec. Idempotent; cancelling an exec that already
    finished returns its terminal result unchanged.

    Args:
        sid (UUID):
        eid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandboxExec, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        sid=sid,
        eid=eid,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sid: UUID,
    eid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Optional[Union[ApiResponseSandboxExec, ErrorResponse]]:
    """Cancel a running exec

     Aborts a running exec. Idempotent; cancelling an exec that already
    finished returns its terminal result unchanged.

    Args:
        sid (UUID):
        eid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandboxExec, ErrorResponse]
    """

    return sync_detailed(
        sid=sid,
        eid=eid,
        client=client,
    ).parsed


async def asyncio_detailed(
    sid: UUID,
    eid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Response[Union[ApiResponseSandboxExec, ErrorResponse]]:
    """Cancel a running exec

     Aborts a running exec. Idempotent; cancelling an exec that already
    finished returns its terminal result unchanged.

    Args:
        sid (UUID):
        eid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandboxExec, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        sid=sid,
        eid=eid,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sid: UUID,
    eid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Optional[Union[ApiResponseSandboxExec, ErrorResponse]]:
    """Cancel a running exec

     Aborts a running exec. Idempotent; cancelling an exec that already
    finished returns its terminal result unchanged.

    Args:
        sid (UUID):
        eid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandboxExec, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            sid=sid,
            eid=eid,
            client=client,
        )
    ).parsed
