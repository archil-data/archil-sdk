from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_message import ApiResponseMessage
from ...models.error_response import ErrorResponse
from ...models.revoke_delegation_request import RevokeDelegationRequest
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: RevokeDelegationRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": f"/api/disks/{id}/revoke-delegation",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseMessage, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseMessage.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = ErrorResponse.from_dict(response.json())

        return response_400

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
) -> Response[Union[ApiResponseMessage, ErrorResponse]]:
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
    body: RevokeDelegationRequest,
) -> Response[Union[ApiResponseMessage, ErrorResponse]]:
    """Revoke a delegation

     Forcibly revokes the delegation a client holds on an inode. Use this to reclaim write access from a
    client that is unreachable or crashed without checking its delegations in.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (RevokeDelegationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseMessage, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    *,
    client: Union[AuthenticatedClient, Client],
    body: RevokeDelegationRequest,
) -> Optional[Union[ApiResponseMessage, ErrorResponse]]:
    """Revoke a delegation

     Forcibly revokes the delegation a client holds on an inode. Use this to reclaim write access from a
    client that is unreachable or crashed without checking its delegations in.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (RevokeDelegationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseMessage, ErrorResponse]
    """

    return sync_detailed(
        id=id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: Union[AuthenticatedClient, Client],
    body: RevokeDelegationRequest,
) -> Response[Union[ApiResponseMessage, ErrorResponse]]:
    """Revoke a delegation

     Forcibly revokes the delegation a client holds on an inode. Use this to reclaim write access from a
    client that is unreachable or crashed without checking its delegations in.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (RevokeDelegationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseMessage, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    *,
    client: Union[AuthenticatedClient, Client],
    body: RevokeDelegationRequest,
) -> Optional[Union[ApiResponseMessage, ErrorResponse]]:
    """Revoke a delegation

     Forcibly revokes the delegation a client holds on an inode. Use this to reclaim write access from a
    client that is unreachable or crashed without checking its delegations in.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (RevokeDelegationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseMessage, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed
