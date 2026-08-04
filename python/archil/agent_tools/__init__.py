"""Drop-in agent tools for Archil disks.

Turn a disk — or a multi-disk workspace — into a ready-made filesystem toolset
(read_file, write_file, delete_file, list_files, grep, run_bash) for popular
agent frameworks::

    tools = disk.agent_tools()
    agent = Agent(tools=tools.for_openai_agents())

    ws = archil.workspace({"data": disk_a, "cache": disk_b})
    agent = Agent(tools=ws.agent_tools().for_langchain())
"""

from ._specs import BoundTool, ToolError
from ._toolset import AgentToolset

__all__ = ["AgentToolset", "BoundTool", "ToolError"]
