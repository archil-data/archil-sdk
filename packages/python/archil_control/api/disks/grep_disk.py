from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_grep_disk import ApiResponseGrepDisk
from ...models.error_response import ErrorResponse
from ...models.grep_disk_request import GrepDiskRequest
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: GrepDiskRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": f"/api/disks/{id}/grep",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseGrepDisk, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseGrepDisk.from_dict(response.json())

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
) -> Response[Union[ApiResponseGrepDisk, ErrorResponse]]:
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
    body: GrepDiskRequest,
) -> Response[Union[ApiResponseGrepDisk, ErrorResponse]]:
    """Constant-time parallel grep over a directory on a disk

     Searches files under a directory on the disk for lines matching a
    regular expression. Listing and matching are fanned out across
    ephemeral exec containers, so the request finishes within the user's
    time budget regardless of the size of the directory.

    The user controls cost and latency with three knobs:

    - `maxDurationSeconds` is the wall-clock deadline.
    - `concurrency` is the maximum number of parallel grep workers.
      Higher concurrency finishes larger datasets within the deadline;
      the controlplane clamps to the runtime fleet's current capacity.
    - `maxResults` causes the search to short-circuit after the
      aggregator has collected this many matches.

    With `recursive: false` only files directly under `directory` are
    searched. With `recursive: true` subdirectories are walked
    breadth-first and grep workers are dispatched as soon as each level
    finishes listing — listing and matching overlap.

    The matches returned when stopping early on `maxResults` are a sample
    of whichever workers reported first, not the lexicographically first
    N. The response surfaces `stoppedReason` so callers can distinguish
    completion from early termination.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (GrepDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseGrepDisk, ErrorResponse]]
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
    body: GrepDiskRequest,
) -> Optional[Union[ApiResponseGrepDisk, ErrorResponse]]:
    """Constant-time parallel grep over a directory on a disk

     Searches files under a directory on the disk for lines matching a
    regular expression. Listing and matching are fanned out across
    ephemeral exec containers, so the request finishes within the user's
    time budget regardless of the size of the directory.

    The user controls cost and latency with three knobs:

    - `maxDurationSeconds` is the wall-clock deadline.
    - `concurrency` is the maximum number of parallel grep workers.
      Higher concurrency finishes larger datasets within the deadline;
      the controlplane clamps to the runtime fleet's current capacity.
    - `maxResults` causes the search to short-circuit after the
      aggregator has collected this many matches.

    With `recursive: false` only files directly under `directory` are
    searched. With `recursive: true` subdirectories are walked
    breadth-first and grep workers are dispatched as soon as each level
    finishes listing — listing and matching overlap.

    The matches returned when stopping early on `maxResults` are a sample
    of whichever workers reported first, not the lexicographically first
    N. The response surfaces `stoppedReason` so callers can distinguish
    completion from early termination.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (GrepDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseGrepDisk, ErrorResponse]
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
    body: GrepDiskRequest,
) -> Response[Union[ApiResponseGrepDisk, ErrorResponse]]:
    """Constant-time parallel grep over a directory on a disk

     Searches files under a directory on the disk for lines matching a
    regular expression. Listing and matching are fanned out across
    ephemeral exec containers, so the request finishes within the user's
    time budget regardless of the size of the directory.

    The user controls cost and latency with three knobs:

    - `maxDurationSeconds` is the wall-clock deadline.
    - `concurrency` is the maximum number of parallel grep workers.
      Higher concurrency finishes larger datasets within the deadline;
      the controlplane clamps to the runtime fleet's current capacity.
    - `maxResults` causes the search to short-circuit after the
      aggregator has collected this many matches.

    With `recursive: false` only files directly under `directory` are
    searched. With `recursive: true` subdirectories are walked
    breadth-first and grep workers are dispatched as soon as each level
    finishes listing — listing and matching overlap.

    The matches returned when stopping early on `maxResults` are a sample
    of whichever workers reported first, not the lexicographically first
    N. The response surfaces `stoppedReason` so callers can distinguish
    completion from early termination.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (GrepDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseGrepDisk, ErrorResponse]]
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
    body: GrepDiskRequest,
) -> Optional[Union[ApiResponseGrepDisk, ErrorResponse]]:
    """Constant-time parallel grep over a directory on a disk

     Searches files under a directory on the disk for lines matching a
    regular expression. Listing and matching are fanned out across
    ephemeral exec containers, so the request finishes within the user's
    time budget regardless of the size of the directory.

    The user controls cost and latency with three knobs:

    - `maxDurationSeconds` is the wall-clock deadline.
    - `concurrency` is the maximum number of parallel grep workers.
      Higher concurrency finishes larger datasets within the deadline;
      the controlplane clamps to the runtime fleet's current capacity.
    - `maxResults` causes the search to short-circuit after the
      aggregator has collected this many matches.

    With `recursive: false` only files directly under `directory` are
    searched. With `recursive: true` subdirectories are walked
    breadth-first and grep workers are dispatched as soon as each level
    finishes listing — listing and matching overlap.

    The matches returned when stopping early on `maxResults` are a sample
    of whichever workers reported first, not the lexicographically first
    N. The response surfaces `stoppedReason` so callers can distinguish
    completion from early termination.

    Args:
        id (str):  Example: dsk-0123456789abcdef.
        body (GrepDiskRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseGrepDisk, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed
