from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_sandbox_list import ApiResponseSandboxList
from ...models.error_response import ErrorResponse
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    filesystem: Union[Unset, str] = UNSET,
) -> dict[str, Any]:
    params: dict[str, Any] = {}

    params["filesystem"] = filesystem

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/api/sandboxes",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseSandboxList, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseSandboxList.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = ErrorResponse.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = ErrorResponse.from_dict(response.json())

        return response_401

    if response.status_code == 500:
        response_500 = ErrorResponse.from_dict(response.json())

        return response_500

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Response[Union[ApiResponseSandboxList, ErrorResponse]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    filesystem: Union[Unset, str] = UNSET,
) -> Response[Union[ApiResponseSandboxList, ErrorResponse]]:
    """List sandboxes

     All the account's sandboxes, oldest first.

    Args:
        filesystem (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandboxList, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        filesystem=filesystem,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: Union[AuthenticatedClient, Client],
    filesystem: Union[Unset, str] = UNSET,
) -> Optional[Union[ApiResponseSandboxList, ErrorResponse]]:
    """List sandboxes

     All the account's sandboxes, oldest first.

    Args:
        filesystem (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandboxList, ErrorResponse]
    """

    return sync_detailed(
        client=client,
        filesystem=filesystem,
    ).parsed


async def asyncio_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    filesystem: Union[Unset, str] = UNSET,
) -> Response[Union[ApiResponseSandboxList, ErrorResponse]]:
    """List sandboxes

     All the account's sandboxes, oldest first.

    Args:
        filesystem (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseSandboxList, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        filesystem=filesystem,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: Union[AuthenticatedClient, Client],
    filesystem: Union[Unset, str] = UNSET,
) -> Optional[Union[ApiResponseSandboxList, ErrorResponse]]:
    """List sandboxes

     All the account's sandboxes, oldest first.

    Args:
        filesystem (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseSandboxList, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            client=client,
            filesystem=filesystem,
        )
    ).parsed
