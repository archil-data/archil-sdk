from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_create_disk import ApiResponseCreateDisk
from ...models.create_disk_request import CreateDiskRequest
from ...models.error_response import ErrorResponse
from ...types import Response


def _get_kwargs(
    *,
    body: CreateDiskRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/api/disks",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseCreateDisk, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseCreateDisk.from_dict(response.json())

        return response_200

    if response.status_code == 201:
        response_201 = ApiResponseCreateDisk.from_dict(response.json())

        return response_201

    if response.status_code == 400:
        response_400 = ErrorResponse.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = ErrorResponse.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = ErrorResponse.from_dict(response.json())

        return response_403

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
) -> Response[Union[ApiResponseCreateDisk, ErrorResponse]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    body: CreateDiskRequest,
) -> Response[Union[ApiResponseCreateDisk, ErrorResponse]]:
    """Create a new disk

     Creates a new disk with the specified configuration. A default token
    user is automatically generated and returned in the response, so the
    disk is immediately mountable. The one-time token appears in
    `authorizedUsers[].token` and cannot be retrieved again.

    To provide your own users instead, pass the deprecated `authMethods`
    field or call AddDiskUser after creation.

    Args:
        body (CreateDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseCreateDisk, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: Union[AuthenticatedClient, Client],
    body: CreateDiskRequest,
) -> Optional[Union[ApiResponseCreateDisk, ErrorResponse]]:
    """Create a new disk

     Creates a new disk with the specified configuration. A default token
    user is automatically generated and returned in the response, so the
    disk is immediately mountable. The one-time token appears in
    `authorizedUsers[].token` and cannot be retrieved again.

    To provide your own users instead, pass the deprecated `authMethods`
    field or call AddDiskUser after creation.

    Args:
        body (CreateDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseCreateDisk, ErrorResponse]
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    body: CreateDiskRequest,
) -> Response[Union[ApiResponseCreateDisk, ErrorResponse]]:
    """Create a new disk

     Creates a new disk with the specified configuration. A default token
    user is automatically generated and returned in the response, so the
    disk is immediately mountable. The one-time token appears in
    `authorizedUsers[].token` and cannot be retrieved again.

    To provide your own users instead, pass the deprecated `authMethods`
    field or call AddDiskUser after creation.

    Args:
        body (CreateDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseCreateDisk, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: Union[AuthenticatedClient, Client],
    body: CreateDiskRequest,
) -> Optional[Union[ApiResponseCreateDisk, ErrorResponse]]:
    """Create a new disk

     Creates a new disk with the specified configuration. A default token
    user is automatically generated and returned in the response, so the
    disk is immediately mountable. The one-time token appears in
    `authorizedUsers[].token` and cannot be retrieved again.

    To provide your own users instead, pass the deprecated `authMethods`
    field or call AddDiskUser after creation.

    Args:
        body (CreateDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseCreateDisk, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
