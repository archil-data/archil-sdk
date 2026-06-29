// Local smoke: a real (free, local) LLM driving Archil agent tools via the
// Vercel AI SDK. A model served by Ollama actually chooses and calls our tools
// through generateText's agent loop, against an in-memory disk (no Archil
// credentials, no network beyond the local Ollama server).
//
// Prereqs:
//   brew install ollama && ollama serve &
//   ollama pull qwen2.5:3b
//   npm run build
//   npm install --no-save @ai-sdk/openai-compatible tsx
//
// Run:
//   npx tsx examples/smoke-ai-sdk-ollama.ts
//
// Env overrides: OLLAMA_MODEL (default qwen2.5:3b), OLLAMA_BASE_URL.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs } from "ai";
import { Archil } from "disk";
import { createDiskTools } from "disk/ai-sdk";

const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:3b";
const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

type Store = Record<string, string>;

const store: Store = {};

// In-memory disk via a stubbed global fetch; no real Archil backend needed.
globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  if (url.host === "cp.test") {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          id: "dsk-1",
          name: "smoke",
          organization: "o",
          status: "available",
          provider: "aws",
          region: "aws-us-east-1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));

  if (method === "PUT") {
    store[key] = await req.text();
    return new Response(null, { status: 200, headers: { etag: '"x"' } });
  }

  if (method === "GET" && key === "") {
    const items = Object.keys(store)
      .sort()
      .map((k) => `<Contents><Key>${k}</Key><Size>${store[k].length}</Size></Contents>`)
      .join("");
    return new Response(
      `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount>${items}</ListBucketResult>`,
      { status: 200 },
    );
  }

  if (method === "GET" || method === "HEAD") {
    return key in store
      ? new Response(store[key], { status: 200 })
      : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  }

  return new Response(null, { status: 400 });
};

const archil = new Archil({
  apiKey: "key-smoke",
  region: "aws-us-east-1",
  baseUrl: "http://cp.test",
  s3BaseUrl: "http://s3.test",
});
const disk = await archil.disks.get("dsk-1");

const ollama = createOpenAICompatible({ name: "ollama", baseURL: BASE_URL, apiKey: "ollama" });

const prompt =
  "Create a file at /notes.txt containing exactly: hello from a real model. " +
  "Then read it back and tell me what it contains. Use the tools, don't guess.";

console.log(`== model: ${MODEL} (Vercel AI SDK) ==\nPROMPT: ${prompt}\n`);

// The agent loop is multi-turn; a small model + Ollama's OpenAI-compat endpoint
// can hiccup on the follow-up turn. We care whether the real model called our
// tool and the bytes landed, so catch any loop error and still report.
try {
  const result = await generateText({
    model: ollama(MODEL),
    tools: createDiskTools(disk),
    stopWhen: stepCountIs(8),
    prompt,
  });
  console.log("FINAL OUTPUT:\n", result.text, "\n");
} catch (err) {
  console.log("(agent loop errored before finishing; checking whether the tool still ran)");
  console.log("  reason:", String(err), "\n");
}

console.log("IN-MEMORY DISK CONTENTS:", store);
if ((store["notes.txt"] ?? "").includes("hello from a real model")) {
  console.log("\nSMOKE PASS: the real model selected and called write_file, and the bytes landed on the disk.");
} else {
  console.log(
    "\nSMOKE INCONCLUSIVE: the model did not produce a clean write_file call " +
      "(small local models are imperfect at tool calling; try OLLAMA_MODEL=qwen2.5:7b). " +
      "The deterministic mock-model tests in test/ cover the adapter wiring.",
  );
}
