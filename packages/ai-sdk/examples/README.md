# Local smoke examples

Scripts that drive the Archil **agent tools** with a real LLM to sanity-check
that an actual model selects and calls the tools, against an **in-memory disk**
(a stubbed `fetch`), so they need **no Archil credentials**.

> These are **not run in CI** — and they're **not published to npm** (the
> package `files` allowlist ships only `dist/`). CI uses deterministic
> mock-model tests (`test/agent-tools.test.ts`) that need no LLM.

## Prerequisites

```bash
npm run build                                        # the example imports dist
npm install --no-save @ai-sdk/openai-compatible tsx   # provider + TS runner
```

Plus a model endpoint — either local Ollama (free, no key) or a free hosted
OpenAI-compatible endpoint.

```bash
brew install ollama && ollama serve &
ollama pull qwen2.5:3b
```

## Run

```bash
npx tsx examples/smoke-ai-sdk-ollama.ts
```

Environment overrides: `OLLAMA_MODEL` (default `qwen2.5:3b`), `OLLAMA_BASE_URL`
(default `http://localhost:11434/v1`).

### Heads-up on Ollama

Ollama's OpenAI-compatible endpoint currently returns a 400 on the tool-result
turn with the AI SDK, so a local Ollama run often reports **inconclusive** (the
script handles this gracefully). For a clean end-to-end run, point it at a free
hosted OpenAI-compatible endpoint that fully supports tool calling — e.g. set
`OLLAMA_BASE_URL` to that endpoint and supply its key. The reliable keyless,
local real-LLM check is the **Python** example (`python-libs/disk/examples`),
which goes through the OpenAI client and works against Ollama directly.
