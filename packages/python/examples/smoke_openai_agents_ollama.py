#!/usr/bin/env python3
"""Local smoke: a real (free, local) LLM driving Archil agent tools.

Runs the OpenAI Agents loop with a real model served by Ollama — so an actual
model *chooses and calls* our tools — against an in-memory disk (so it needs no
Archil credentials and no network beyond the local Ollama server). This is the
"does a real model actually use these tools" check that the deterministic
mock-model tests can't give you.

Prereqs:
    brew install ollama && ollama serve &
    ollama pull qwen2.5:3b
    pip install -e ".[openai-agents]"

Run:
    python examples/smoke_openai_agents_ollama.py

Env overrides: OLLAMA_MODEL (default qwen2.5:3b), OLLAMA_BASE_URL.
"""

from __future__ import annotations

import asyncio
import os
from urllib.parse import unquote

import httpx

from archil import Archil

MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")
BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")


# --- in-memory disk (injected transport; no real Archil backend) -----------


class InMemoryFleet:
    """A tiny control-plane + S3 store routed through httpx.MockTransport, so the
    real SDK code paths run with no live backend."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.url.host == "cp.test":
            if req.url.path.endswith("/exec"):
                return self._ok({"exitCode": 0, "stdout": "", "stderr": "",
                                 "timing": {"totalMs": 1, "queueMs": 0, "executeMs": 1}})
            return self._ok({"id": "dsk-1", "name": "smoke", "organization": "o",
                             "status": "available", "provider": "aws",
                             "region": "aws-us-east-1", "createdAt": "2026-01-01T00:00:00Z"})
        key = unquote(req.url.path.split("/", 2)[2]) if req.url.path.count("/") >= 2 else ""
        if req.method == "PUT":
            self.store[key] = req.content
            return httpx.Response(200, headers={"etag": '"x"'})
        if req.method == "DELETE":
            self.store.pop(key, None)
            return httpx.Response(204)
        if req.method == "GET" and key == "":
            return httpx.Response(200, content=self._list_xml(req.url.params.get("prefix", "")))
        if req.method in ("GET", "HEAD"):
            if key not in self.store:
                return httpx.Response(404, content=b"<Error><Code>NoSuchKey</Code></Error>")
            return httpx.Response(200, content=self.store[key])
        return httpx.Response(400)

    @staticmethod
    def _ok(data) -> httpx.Response:
        return httpx.Response(200, json={"success": True, "data": data})

    def _list_xml(self, prefix: str) -> bytes:
        items = "".join(
            f"<Contents><Key>{k}</Key><Size>{len(v)}</Size></Contents>"
            for k, v in sorted(self.store.items())
            if k.startswith(prefix)
        )
        return (f'<?xml version="1.0"?><ListBucketResult><KeyCount>1</KeyCount>'
                f"<IsTruncated>false</IsTruncated><Prefix>{prefix}</Prefix>{items}"
                f"</ListBucketResult>").encode()


async def main() -> None:
    from agents import Agent, OpenAIChatCompletionsModel, Runner, set_tracing_disabled
    from openai import AsyncOpenAI

    set_tracing_disabled(True)  # no OpenAI key needed
    fleet = InMemoryFleet()
    client = Archil(
        api_key="key-smoke", region="aws-us-east-1",
        base_url="http://cp.test", s3_base_url="http://s3.test",
        _http_transport=httpx.MockTransport(fleet),
    )
    disk = client.disks.get("dsk-1")

    model = OpenAIChatCompletionsModel(
        model=MODEL, openai_client=AsyncOpenAI(base_url=BASE_URL, api_key="ollama")
    )
    agent = Agent(
        name="fs-assistant",
        instructions=(
            "You are a coding assistant with a filesystem. Use the provided tools "
            "to read and write files. Paths are absolute from '/'. Always use the "
            "tools rather than guessing file contents."
        ),
        model=model,
        tools=disk.agent_tools().for_openai_agents(),
    )

    prompt = (
        "Create a file at /notes.txt containing exactly: hello from a real model. "
        "Then read it back and tell me what it contains."
    )
    print(f"== model: {MODEL} ==\nPROMPT: {prompt}\n")
    result = await Runner.run(agent, prompt, max_turns=8)

    print("FINAL OUTPUT:\n", result.final_output, "\n")
    print("IN-MEMORY DISK CONTENTS:", {k: v.decode() for k, v in fleet.store.items()})

    wrote = fleet.store.get("notes.txt", b"").decode()
    if "hello from a real model" in wrote:
        print("\n✅ SMOKE PASS — the real model called write_file and the bytes landed.")
    else:
        print("\n⚠️  SMOKE INCONCLUSIVE — the model may not have written the file "
              "(small models are imperfect at tool use). Inspect the output above.")


if __name__ == "__main__":
    asyncio.run(main())
