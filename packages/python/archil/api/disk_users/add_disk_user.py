from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_authorized_user import ApiResponseAuthorizedUser
from ...models.aws_sts_user import AwsStsUser
from ...models.error_response import ErrorResponse
from ...models.token_user import TokenUser
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: Union["AwsStsUser", "TokenUser"],
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": f"/api/disks/{id}/users",
    }

    _kwargs["json"]: dict[str, Any]
    if isinstance(body, TokenUser):
        _kwargs["json"] = body.to_dict()
    else:
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseAuthorizedUser, ErrorResponse]]:
    if response.status_code == 201:
        response_201 = ApiResponseAuthorizedUser.from_dict(response.json())

        return response_201

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
) -> Response[Union[ApiResponseAuthorizedUser, ErrorResponse]]:
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
    body: Union["AwsStsUser", "TokenUser"],
) -> Response[Union[ApiResponseAuthorizedUser, ErrorResponse]]:
    """Add user to disk

     Adds an authorized user to a disk. Users can authenticate via:
    - **token**: A shared token with a nickname and 4-character suffix
    - **awssts**: AWS STS role assumption with an IAM principal ARN

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (Union['AwsStsUser', 'TokenUser']):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseAuthorizedUser, ErrorResponse]]
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
    body: Union["AwsStsUser", "TokenUser"],
) -> Optional[Union[ApiResponseAuthorizedUser, ErrorResponse]]:
    """Add user to disk

     Adds an authorized user to a disk. Users can authenticate via:
    - **token**: A shared token with a nickname and 4-character suffix
    - **awssts**: AWS STS role assumption with an IAM principal ARN

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (Union['AwsStsUser', 'TokenUser']):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseAuthorizedUser, ErrorResponse]
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
    body: Union["AwsStsUser", "TokenUser"],
) -> Response[Union[ApiResponseAuthorizedUser, ErrorResponse]]:
    """Add user to disk

     Adds an authorized user to a disk. Users can authenticate via:
    - **token**: A shared token with a nickname and 4-character suffix
    - **awssts**: AWS STS role assumption with an IAM principal ARN

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (Union['AwsStsUser', 'TokenUser']):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseAuthorizedUser, ErrorResponse]]
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
    body: Union["AwsStsUser", "TokenUser"],
) -> Optional[Union[ApiResponseAuthorizedUser, ErrorResponse]]:
    """Add user to disk

     Adds an authorized user to a disk. Users can authenticate via:
    - **token**: A shared token with a nickname and 4-character suffix
    - **awssts**: AWS STS role assumption with an IAM principal ARN

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (Union['AwsStsUser', 'TokenUser']):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseAuthorizedUser, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed
