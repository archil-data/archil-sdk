from http import HTTPStatus
from typing import Any, Optional, Union
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_sandbox_exec_list import ApiResponseSandboxExecList
from ...models.error_response import ErrorResponse
from ...types import Response


def _get_kwargs(
    sid: UUID,
) -> dict[str, Any]:
    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": f"/api/sandboxes/{sid}/execs",
    }

    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseSandboxExecList, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseSandboxExecList.from_dict(response.json())

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
) -> Response[Union[ApiResponseSandboxExecList, ErrorResponse]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Response[Union[ApiResponseSandboxExecList, ErrorResponse]]:
    """List recent execs

     The sandbox's most recent execs, newest first.

    Args:
        sid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandboxExecList, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        sid=sid,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Optional[Union[ApiResponseSandboxExecList, ErrorResponse]]:
    """List recent execs

     The sandbox's most recent execs, newest first.

    Args:
        sid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandboxExecList, ErrorResponse]
    """

    return sync_detailed(
        sid=sid,
        client=client,
    ).parsed


async def asyncio_detailed(
    sid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Response[Union[ApiResponseSandboxExecList, ErrorResponse]]:
    """List recent execs

     The sandbox's most recent execs, newest first.

    Args:
        sid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandboxExecList, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        sid=sid,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Optional[Union[ApiResponseSandboxExecList, ErrorResponse]]:
    """List recent execs

     The sandbox's most recent execs, newest first.

    Args:
        sid (UUID):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandboxExecList, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            sid=sid,
            client=client,
        )
    ).parsed
