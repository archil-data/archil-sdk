from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_exec import ApiResponseExec
from ...models.error_response import ErrorResponse
from ...models.exec_request import ExecRequest
from ...types import Response


def _get_kwargs(
    *,
    body: ExecRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/api/exec",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseExec, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseExec.from_dict(response.json())

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

    if response.status_code == 504:
        response_504 = ErrorResponse.from_dict(response.json())

        return response_504

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Response[Union[ApiResponseExec, ErrorResponse]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    body: ExecRequest,
) -> Response[Union[ApiResponseExec, ErrorResponse]]:
    """Execute a command with multiple disks mounted

     Launches a container with the supplied set of disks each mounted at its
    own relative path under `/mnt/archil`, runs the command to completion,
    and shuts down the container. Activation is atomic: every disk mounts
    or none of them do.

    Relative paths must be non-empty, non-absolute, and contain no `.` /
    `..` segments. Mounting two disks at the same relative path is an
    error.

    Args:
        body (ExecRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseExec, ErrorResponse]]
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
    body: ExecRequest,
) -> Optional[Union[ApiResponseExec, ErrorResponse]]:
    """Execute a command with multiple disks mounted

     Launches a container with the supplied set of disks each mounted at its
    own relative path under `/mnt/archil`, runs the command to completion,
    and shuts down the container. Activation is atomic: every disk mounts
    or none of them do.

    Relative paths must be non-empty, non-absolute, and contain no `.` /
    `..` segments. Mounting two disks at the same relative path is an
    error.

    Args:
        body (ExecRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseExec, ErrorResponse]
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    body: ExecRequest,
) -> Response[Union[ApiResponseExec, ErrorResponse]]:
    """Execute a command with multiple disks mounted

     Launches a container with the supplied set of disks each mounted at its
    own relative path under `/mnt/archil`, runs the command to completion,
    and shuts down the container. Activation is atomic: every disk mounts
    or none of them do.

    Relative paths must be non-empty, non-absolute, and contain no `.` /
    `..` segments. Mounting two disks at the same relative path is an
    error.

    Args:
        body (ExecRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseExec, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: Union[AuthenticatedClient, Client],
    body: ExecRequest,
) -> Optional[Union[ApiResponseExec, ErrorResponse]]:
    """Execute a command with multiple disks mounted

     Launches a container with the supplied set of disks each mounted at its
    own relative path under `/mnt/archil`, runs the command to completion,
    and shuts down the container. Activation is atomic: every disk mounts
    or none of them do.

    Relative paths must be non-empty, non-absolute, and contain no `.` /
    `..` segments. Mounting two disks at the same relative path is an
    error.

    Args:
        body (ExecRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseExec, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
