from http import HTTPStatus
from typing import Any, Optional, Union

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.api_response_activity_list import ApiResponseActivityList
from ...models.error_response import ErrorResponse
from ...models.list_activity_level_item import ListActivityLevelItem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    limit: Union[Unset, int] = UNSET,
    cursor: Union[Unset, str] = UNSET,
    disk_id: Union[Unset, str] = UNSET,
    event_type: Union[Unset, list[str]] = UNSET,
    level: Union[Unset, list[ListActivityLevelItem]] = UNSET,
) -> dict[str, Any]:
    params: dict[str, Any] = {}

    params["limit"] = limit

    params["cursor"] = cursor

    params["diskId"] = disk_id

    json_event_type: Union[Unset, list[str]] = UNSET
    if not isinstance(event_type, Unset):
        json_event_type = event_type

    params["eventType"] = json_event_type

    json_level: Union[Unset, list[str]] = UNSET
    if not isinstance(level, Unset):
        json_level = []
        for level_item_data in level:
            level_item = level_item_data.value
            json_level.append(level_item)

    params["level"] = json_level

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/api/activity",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: Union[AuthenticatedClient, Client], response: httpx.Response
) -> Optional[Union[ApiResponseActivityList, ErrorResponse]]:
    if response.status_code == 200:
        response_200 = ApiResponseActivityList.from_dict(response.json())

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
) -> Response[Union[ApiResponseActivityList, ErrorResponse]]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    limit: Union[Unset, int] = UNSET,
    cursor: Union[Unset, str] = UNSET,
    disk_id: Union[Unset, str] = UNSET,
    event_type: Union[Unset, list[str]] = UNSET,
    level: Union[Unset, list[ListActivityLevelItem]] = UNSET,
) -> Response[Union[ApiResponseActivityList, ErrorResponse]]:
    """List activity events

     Returns the authenticated account's activity events (disk lifecycle and exec events), newest first.
    Omitting `limit` returns up to 50 events; pass the response's `nextCursor` back as `cursor` to fetch
    the next page.

    Args:
        limit (Union[Unset, int]):
        cursor (Union[Unset, str]):
        disk_id (Union[Unset, str]):  Example: dsk-0123456789abcdef.
        event_type (Union[Unset, list[str]]):
        level (Union[Unset, list[ListActivityLevelItem]]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseActivityList, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        limit=limit,
        cursor=cursor,
        disk_id=disk_id,
        event_type=event_type,
        level=level,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: Union[AuthenticatedClient, Client],
    limit: Union[Unset, int] = UNSET,
    cursor: Union[Unset, str] = UNSET,
    disk_id: Union[Unset, str] = UNSET,
    event_type: Union[Unset, list[str]] = UNSET,
    level: Union[Unset, list[ListActivityLevelItem]] = UNSET,
) -> Optional[Union[ApiResponseActivityList, ErrorResponse]]:
    """List activity events

     Returns the authenticated account's activity events (disk lifecycle and exec events), newest first.
    Omitting `limit` returns up to 50 events; pass the response's `nextCursor` back as `cursor` to fetch
    the next page.

    Args:
        limit (Union[Unset, int]):
        cursor (Union[Unset, str]):
        disk_id (Union[Unset, str]):  Example: dsk-0123456789abcdef.
        event_type (Union[Unset, list[str]]):
        level (Union[Unset, list[ListActivityLevelItem]]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseActivityList, ErrorResponse]
    """

    return sync_detailed(
        client=client,
        limit=limit,
        cursor=cursor,
        disk_id=disk_id,
        event_type=event_type,
        level=level,
    ).parsed


async def asyncio_detailed(
    *,
    client: Union[AuthenticatedClient, Client],
    limit: Union[Unset, int] = UNSET,
    cursor: Union[Unset, str] = UNSET,
    disk_id: Union[Unset, str] = UNSET,
    event_type: Union[Unset, list[str]] = UNSET,
    level: Union[Unset, list[ListActivityLevelItem]] = UNSET,
) -> Response[Union[ApiResponseActivityList, ErrorResponse]]:
    """List activity events

     Returns the authenticated account's activity events (disk lifecycle and exec events), newest first.
    Omitting `limit` returns up to 50 events; pass the response's `nextCursor` back as `cursor` to fetch
    the next page.

    Args:
        limit (Union[Unset, int]):
        cursor (Union[Unset, str]):
        disk_id (Union[Unset, str]):  Example: dsk-0123456789abcdef.
        event_type (Union[Unset, list[str]]):
        level (Union[Unset, list[ListActivityLevelItem]]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Union[ApiResponseActivityList, ErrorResponse]]
    """

    kwargs = _get_kwargs(
        limit=limit,
        cursor=cursor,
        disk_id=disk_id,
        event_type=event_type,
        level=level,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: Union[AuthenticatedClient, Client],
    limit: Union[Unset, int] = UNSET,
    cursor: Union[Unset, str] = UNSET,
    disk_id: Union[Unset, str] = UNSET,
    event_type: Union[Unset, list[str]] = UNSET,
    level: Union[Unset, list[ListActivityLevelItem]] = UNSET,
) -> Optional[Union[ApiResponseActivityList, ErrorResponse]]:
    """List activity events

     Returns the authenticated account's activity events (disk lifecycle and exec events), newest first.
    Omitting `limit` returns up to 50 events; pass the response's `nextCursor` back as `cursor` to fetch
    the next page.

    Args:
        limit (Union[Unset, int]):
        cursor (Union[Unset, str]):
        disk_id (Union[Unset, str]):  Example: dsk-0123456789abcdef.
        event_type (Union[Unset, list[str]]):
        level (Union[Unset, list[ListActivityLevelItem]]):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Union[ApiResponseActivityList, ErrorResponse]
    """

    return (
        await asyncio_detailed(
            client=client,
            limit=limit,
            cursor=cursor,
            disk_id=disk_id,
            event_type=event_type,
            level=level,
        )
    ).parsed
