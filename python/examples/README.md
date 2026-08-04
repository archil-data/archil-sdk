# Local smoke examples

Scripts that drive the Archil **agent tools** with a real, free, **local** LLM
(via [Ollama](https://ollama.com)) to sanity-check that an actual model selects
and calls the tools. They run against an **in-memory disk** (an injected HTTP
transport), so they need **no Archil credentials** and no network beyond the
local Ollama server.

> These are **not run in CI** — CI uses deterministic mock-model tests
> (`tests/test_agent_tools.py`) that need no LLM. These scripts are for local
> validation and demos.

## Prerequisites

```bash
brew install ollama          # or see https://ollama.com/download
ollama serve &               # start the local model server
ollama pull qwen2.5:3b       # a small, tool-capable model (~1.9 GB)

# from python-libs/disk, in your venv:
pip install -e ".[openai-agents]"
```

## Run

```bash
python examples/smoke_openai_agents_ollama.py
```

It creates a file via the real model's `write_file` tool call, reads it back,
and prints whether the bytes landed (`✅ SMOKE PASS`).

Environment overrides: `OLLAMA_MODEL` (default `qwen2.5:3b`), `OLLAMA_BASE_URL`
(default `http://localhost:11434/v1`).

Note: small local models are imperfect at tool calling — if a run is
inconclusive, try a larger model (e.g. `qwen2.5:7b`) or re-run.
