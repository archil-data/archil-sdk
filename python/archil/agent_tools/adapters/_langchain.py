"""Adapter for LangChain / LangGraph.

Wraps each bound tool in a ``StructuredTool`` driven by the JSON-Schema args and
an async coroutine. Sync invocation is intentionally unsupported — agent
runtimes call tools asynchronously, and the SDK's work happens on a background
event loop reached via ``.aio``."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._specs import BoundTool

if TYPE_CHECKING:
    from langchain_core.tools import StructuredTool


def to_langchain_tools(tools: list[BoundTool]) -> "list[StructuredTool]":
    try:
        from langchain_core.tools import StructuredTool
    except ImportError as exc:  # pragma: no cover - exercised only without the dep
        raise ImportError(
            "LangChain is required for for_langchain(). "
            "Install it with: pip install langchain-core"
        ) from exc
    return [_structured_tool(StructuredTool, tool) for tool in tools]


def _structured_tool(structured_tool_cls, tool: BoundTool):
    async def _coroutine(**kwargs) -> str:
        return await tool.invoke(kwargs)

    return structured_tool_cls(
        name=tool.name,
        description=tool.description,
        args_schema=tool.parameters,
        coroutine=_coroutine,
    )
