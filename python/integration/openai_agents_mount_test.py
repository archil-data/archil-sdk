#!/usr/bin/env python3
"""End-to-end test for ``archil.openai_agents.ArchilMount``.

Creates a disk, mounts it through the OpenAI Agents SDK in one sandbox and
writes a file, then mounts it read-only in a second sandbox and reads the file
back, and finally reads it through the Archil API. Deletes the disk afterwards.

    python integration/openai_agents_mount_test.py e2b|daytona

Environment variables:
  ARCHIL_API_KEY, ARCHIL_REGION   Archil account and disk region
  E2B_API_KEY                     for the e2b backend
  DAYTONA_API_KEY                 for the daytona backend

Requires ``pip install "archil[openai-agents]" "openai-agents[e2b,daytona]"``.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

from agents import Agent, RunConfig, Runner
from agents.items import ModelResponse
from agents.models.interface import Model
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.usage import Usage
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

import archil
from archil.openai_agents import ArchilMount


def sandbox_client(backend: str):
    if backend == "e2b":
        from agents.extensions.sandbox.e2b import E2BSandboxClient, E2BSandboxClientOptions

        return E2BSandboxClient(), E2BSandboxClientOptions(sandbox_type="e2b", timeout=900), Manifest()
    if backend == "daytona":
        from agents.extensions.sandbox.daytona import (
            DEFAULT_DAYTONA_WORKSPACE_ROOT,
            DaytonaSandboxClient,
            DaytonaSandboxClientOptions,
        )

        options = DaytonaSandboxClientOptions(auto_stop_interval=15)
        return DaytonaSandboxClient(), options, Manifest(root=DEFAULT_DAYTONA_WORKSPACE_ROOT)
    raise SystemExit(f"unknown backend {backend!r}; expected e2b or daytona")


class ScriptedModel(Model):
    """Calls the sandbox shell tool once, then replies with its output. No model API calls."""

    def __init__(self, command: str) -> None:
        self.command = command

    async def get_response(self, system_instructions, input, *args, **kwargs) -> ModelResponse:
        tool_outputs = [item for item in input if isinstance(item, dict) and item.get("type") == "function_call_output"]
        if not tool_outputs:
            call = ResponseFunctionToolCall(
                type="function_call",
                id="fc_1",
                call_id="call_1",
                name="exec_command",
                arguments=json.dumps({"cmd": self.command}),
            )
            return ModelResponse(output=[call], usage=Usage(), response_id=None)
        text = ResponseOutputText(type="output_text", text=str(tool_outputs[-1]["output"]), annotations=[])
        message = ResponseOutputMessage(
            type="message", id="msg_1", role="assistant", status="completed", content=[text]
        )
        return ModelResponse(output=[message], usage=Usage(), response_id=None)

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError


async def run_in_sandbox(backend: str, mount: ArchilMount, command: str, *, via_agent: bool = False) -> str:
    """Attach the disk to a fresh sandbox and run ``command`` there, directly or through an agent's shell tool."""
    client, options, manifest = sandbox_client(backend)
    session = await client.create(manifest=manifest, options=options)
    try:
        async with session:
            mount_path = await mount.attach(session)
            print(f"  mounted {mount.disk} at {mount_path}")
            if via_agent:
                agent: Agent = SandboxAgent(name="reader", model=ScriptedModel(command))
                run = await Runner.run(
                    agent, "Read the file.", run_config=RunConfig(sandbox=SandboxRunConfig(session=session))
                )
                output = str(run.final_output)
                print("  the agent's shell tool ran the command")
            else:
                result = await session.exec(command, timeout=120)
                output = result.stdout.decode().strip()
                if result.exit_code != 0:
                    raise AssertionError(f"{command!r} exited {result.exit_code}: {result.stderr.decode()}")
        print("  released the disk and closed the session")
        return output
    finally:
        await client.delete(session)


def assert_released(disk) -> None:
    held = archil.get_disk(disk.id).list_delegations()
    assert not held, f"delegations still held after the session closed: {held}"
    print("  no delegations left on the disk")


async def main(backend: str) -> None:
    created = archil.create_disk(name=f"openai-agents-mount-{backend}-{int(time.time())}")
    disk, token = created.disk, created.token
    print(f"created {disk.id}")
    expected = f"hello from {backend} {disk.id}"
    try:
        print("sandbox 1: mount and write")
        written = await run_in_sandbox(
            backend,
            ArchilMount(disk=disk.id, token=token, path="data"),
            f"mkdir data/shared && echo '{expected}' > data/hello.txt && cat data/hello.txt",
        )
        assert written == expected, written
        assert_released(disk)

        print("sandbox 2: mount shared, check out a directory, and write")
        shared = await run_in_sandbox(
            backend,
            ArchilMount(disk=disk.id, token=token, path="data", shared=True),
            'sudo archil checkout "$PWD/data/shared" && echo shared > data/shared/note.txt && cat data/hello.txt',
        )
        assert shared == expected, shared
        assert_released(disk)

        print("sandbox 3: mount read-only and read it from an agent's shell tool")
        read_back = await run_in_sandbox(
            backend,
            ArchilMount(disk=disk.id, token=token, path="/mnt/archil", read_only=True),
            "cat /mnt/archil/hello.txt /mnt/archil/shared/note.txt && ! touch /mnt/archil/x 2>/dev/null && echo read-only",
            via_agent=True,
        )
        assert f"{expected}\nshared\nread-only" in read_back, read_back

        from_api = archil.get_disk(disk.id).get_object("hello.txt").decode().strip()
        assert from_api == expected, from_api
        print("read the file through the Archil API")
    finally:
        archil.get_disk(disk.id).delete()
        print(f"deleted {disk.id}")
    print(f"PASS ({backend})")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "e2b"))
