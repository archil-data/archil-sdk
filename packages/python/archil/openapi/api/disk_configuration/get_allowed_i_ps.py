from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_allowed_i_ps import ApiResponseAllowedIPs
from ...models.error_response import ErrorResponse
from ...types import Response


def _get_kwargs(
    id: str,
) -> dict[str, Any]:
    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": f"/api/disks/{id}/allowed-ips",
    }

    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseAllowedIPs, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseAllowedIPs.from_dict(response.json())

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
) -> Response[Union[ApiResponseAllowedIPs, ErrorResponse]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    id: str,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Response[Union[ApiResponseAllowedIPs, ErrorResponse]]:
    """Get IP allowlist

     Returns the current IP allowlist for a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseAllowedIPs, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        id=id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Optional[Union[ApiResponseAllowedIPs, ErrorResponse]]:
    """Get IP allowlist

     Returns the current IP allowlist for a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseAllowedIPs, ErrorResponse]
    """

    return sync_detailed(
        id=id,
        client=client,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Response[Union[ApiResponseAllowedIPs, ErrorResponse]]:
    """Get IP allowlist

     Returns the current IP allowlist for a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseAllowedIPs, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        id=id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    *,
    client: Union[AuthenticatedClient, Client],
) -> Optional[Union[ApiResponseAllowedIPs, ErrorResponse]]:
    """Get IP allowlist

     Returns the current IP allowlist for a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseAllowedIPs, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
        )
    ).parsed
