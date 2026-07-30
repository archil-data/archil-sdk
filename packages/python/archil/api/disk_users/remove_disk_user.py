from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_message import ApiResponseMessage
from ...models.error_response import ErrorResponse
from ...models.remove_disk_user_user_type import RemoveDiskUserUserType
from ...types import UNSET, Response, Unset


def _get_kwargs(
    id: str,
    user_type: RemoveDiskUserUserType,
    *,
    identifier: Union[Unset, str] = UNSET,
    principal: Union[Unset, str] = UNSET,
) -> dict[str, Any]:
    params: dict[str, Any] = {}

    params["identifier"] = identifier

    params["principal"] = principal

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": f"/api/disks/{id}/users/{user_type}",
        "params": params,
    }

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
    user_type: RemoveDiskUserUserType,
    *,
    client: Union[AuthenticatedClient, Client],
    identifier: Union[Unset, str] = UNSET,
    principal: Union[Unset, str] = UNSET,
) -> Response[Union[ApiResponseMessage, ErrorResponse]]:
    """Remove user from disk

     Removes an authorized user from a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        user_type (RemoveDiskUserUserType):
        identifier (Union[Unset, str]):
        principal (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseMessage, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        id=id,
        user_type=user_type,
        identifier=identifier,
        principal=principal,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    user_type: RemoveDiskUserUserType,
    *,
    client: Union[AuthenticatedClient, Client],
    identifier: Union[Unset, str] = UNSET,
    principal: Union[Unset, str] = UNSET,
) -> Optional[Union[ApiResponseMessage, ErrorResponse]]:
    """Remove user from disk

     Removes an authorized user from a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        user_type (RemoveDiskUserUserType):
        identifier (Union[Unset, str]):
        principal (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseMessage, ErrorResponse]
    """

    return sync_detailed(
        id=id,
        user_type=user_type,
        client=client,
        identifier=identifier,
        principal=principal,
    ).parsed


async def asyncio_detailed(
    id: str,
    user_type: RemoveDiskUserUserType,
    *,
    client: Union[AuthenticatedClient, Client],
    identifier: Union[Unset, str] = UNSET,
    principal: Union[Unset, str] = UNSET,
) -> Response[Union[ApiResponseMessage, ErrorResponse]]:
    """Remove user from disk

     Removes an authorized user from a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        user_type (RemoveDiskUserUserType):
        identifier (Union[Unset, str]):
        principal (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseMessage, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        id=id,
        user_type=user_type,
        identifier=identifier,
        principal=principal,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    user_type: RemoveDiskUserUserType,
    *,
    client: Union[AuthenticatedClient, Client],
    identifier: Union[Unset, str] = UNSET,
    principal: Union[Unset, str] = UNSET,
) -> Optional[Union[ApiResponseMessage, ErrorResponse]]:
    """Remove user from disk

     Removes an authorized user from a disk.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        user_type (RemoveDiskUserUserType):
        identifier (Union[Unset, str]):
        principal (Union[Unset, str]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseMessage, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            id=id,
            user_type=user_type,
            client=client,
            identifier=identifier,
            principal=principal,
        )
    ).parsed
