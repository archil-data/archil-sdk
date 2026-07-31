"""Adapter for the OpenAI Agents SDK (``openai-agents``).

Wraps each bound tool in a ``FunctionTool`` whose ``on_invoke_tool`` parses the
model's JSON argument string and dispatches to the shared handler."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from .._specs import BoundTool

if TYPE_CHECKING:
    from agents import FunctionTool


def to_openai_agents_tools(tools: list[BoundTool]) -> "list[FunctionTool]":
    try:
        from agents import FunctionTool
    except ImportError as exc:  # pragma: no cover - exercised only without the dep
        raise ImportError(
            "The OpenAI Agents SDK is required for for_openai_agents(). "
            "Install it with: pip install openai-agents"
        ) from exc
    return [_function_tool(FunctionTool, tool) for tool in tools]


def _function_tool(function_tool_cls, tool: BoundTool):
    async def on_invoke_tool(_ctx, arguments: str) -> str:
        try:
            args = json.loads(arguments) if arguments else {}
        except (json.JSONDecodeError, TypeError) as exc:
            return f"Error: could not parse tool arguments as JSON: {exc}"
        return await tool.invoke(args)

    return function_tool_cls(
        name=tool.name,
        description=tool.description,
        params_json_schema=tool.parameters,
        on_invoke_tool=on_invoke_tool,
        # Our schemas are intentionally lenient (optional params with defaults),
        # so don't ask the SDK to enforce strict JSON-schema conformance.
        strict_json_schema=False,
    )
