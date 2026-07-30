from http import HTTPStatus
from typing import Any, Optional, Union
from uuid import UUID

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_sandbox import ApiResponseSandbox
from ...models.error_response import ErrorResponse
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sid: UUID,
    *,
    wait: Union[Unset, bool] = False,
) -> dict[str, Any]:
    params: dict[str, Any] = {}

    params["wait"] = wait

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": f"/api/sandboxes/{sid}/resume",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseSandbox, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseSandbox.from_dict(response.json())

        return response_200

    if response.status_code == 202:
        response_202 = ApiResponseSandbox.from_dict(response.json())

        return response_202

    if response.status_code == 400:
        response_400 = ErrorResponse.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = ErrorResponse.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = ErrorResponse.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = ErrorResponse.from_dict(response.json())

        return response_409

    if response.status_code == 500:
        response_500 = ErrorResponse.from_dict(response.json())

        return response_500

    if response.status_code == 503:
        response_503 = ErrorResponse.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Response[Union[ApiResponseSandbox, ErrorResponse]]:
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
    wait: Union[Unset, bool] = False,
) -> Response[Union[ApiResponseSandbox, ErrorResponse]]:
    """Resume a sandbox

     Restores a paused sandbox's committed CPU and memory snapshot.
    Resuming a running sandbox or a pending resume is idempotent. Only a
    `paused` sandbox can begin a new resume; `stopped`, `exited`, `failed`,
    `stopping`, `pausing`, or a pending cold start returns 409.

    Args:
        sid (UUID):
        wait (Union[Unset, bool]):  Default: False.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandbox, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        sid=sid,
        wait=wait,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
    wait: Union[Unset, bool] = False,
) -> Optional[Union[ApiResponseSandbox, ErrorResponse]]:
    """Resume a sandbox

     Restores a paused sandbox's committed CPU and memory snapshot.
    Resuming a running sandbox or a pending resume is idempotent. Only a
    `paused` sandbox can begin a new resume; `stopped`, `exited`, `failed`,
    `stopping`, `pausing`, or a pending cold start returns 409.

    Args:
        sid (UUID):
        wait (Union[Unset, bool]):  Default: False.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandbox, ErrorResponse]
    """

    return sync_detailed(
        sid=sid,
        client=client,
        wait=wait,
    ).parsed


async def asyncio_detailed(
    sid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
    wait: Union[Unset, bool] = False,
) -> Response[Union[ApiResponseSandbox, ErrorResponse]]:
    """Resume a sandbox

     Restores a paused sandbox's committed CPU and memory snapshot.
    Resuming a running sandbox or a pending resume is idempotent. Only a
    `paused` sandbox can begin a new resume; `stopped`, `exited`, `failed`,
    `stopping`, `pausing`, or a pending cold start returns 409.

    Args:
        sid (UUID):
        wait (Union[Unset, bool]):  Default: False.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandbox, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        sid=sid,
        wait=wait,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sid: UUID,
    *,
    client: Union[AuthenticatedClient, Client],
    wait: Union[Unset, bool] = False,
) -> Optional[Union[ApiResponseSandbox, ErrorResponse]]:
    """Resume a sandbox

     Restores a paused sandbox's committed CPU and memory snapshot.
    Resuming a running sandbox or a pending resume is idempotent. Only a
    `paused` sandbox can begin a new resume; `stopped`, `exited`, `failed`,
    `stopping`, `pausing`, or a pending cold start returns 409.

    Args:
        sid (UUID):
        wait (Union[Unset, bool]):  Default: False.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandbox, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            sid=sid,
            client=client,
            wait=wait,
        )
    ).parsed
