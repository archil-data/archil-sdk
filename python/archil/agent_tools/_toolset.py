"""The handle returned by ``disk.agent_tools()`` and ``archil.workspace()``.

It binds the shared tool specs to a filesystem target once, then exposes a
typed getter per framework. Each getter returns that framework's native objects
(``list[FunctionTool]``, ``list[StructuredTool]``, …) and imports the framework
lazily, so installing ``archil`` pulls in no agent dependencies."""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ._specs import BoundTool, bind_tools

if TYPE_CHECKING:
    from agents import FunctionTool
    from langchain_core.tools import StructuredTool


class AgentToolset:
    def __init__(self, fs: object, names: Optional[list[str]] = None) -> None:
        self._tools = bind_tools(fs, names)

    @property
    def tools(self) -> list[BoundTool]:
        """The framework-agnostic bound tools. Use a ``for_*`` method to get a
        specific framework's objects; this is the raw form for custom adapters."""
        return self._tools

    def for_openai_agents(self) -> "list[FunctionTool]":
        """Tools for the OpenAI Agents SDK. Requires ``pip install openai-agents``."""
        from .adapters._openai_agents import to_openai_agents_tools

        return to_openai_agents_tools(self._tools)

    def for_langchain(self) -> "list[StructuredTool]":
        """Tools for LangChain / LangGraph. Requires ``pip install langchain-core``."""
        from .adapters._langchain import to_langchain_tools

        return to_langchain_tools(self._tools)
