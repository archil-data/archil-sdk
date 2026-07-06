import assert from "node:assert/strict";
import { ToolLoopAgent, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createMockDisk } from "@archildata/mock";
import { test } from "vitest";
import { createDiskTools } from "../src/index.js";

type JsonBody = Record<string, unknown>;

test("createDiskTools exposes AI SDK tools that a ToolLoopAgent can call", async () => {
  const disk = createMockDisk();
  const tools = createDiskTools(disk);

  assert.deepEqual(
    Object.keys(tools).sort(),
    ["delete_file", "glob", "grep", "list_files", "read_file", "run_bash", "write_file"],
  );

  const agent = new ToolLoopAgent({
    model: mockModelWithToolCall({
      toolName: "write_file",
      input: { path: "/agent.txt", content: "written by the agent" },
      finalText: "done",
    }),
    tools,
    stopWhen: stepCountIs(4),
  });

  const res = await agent.generate({ prompt: "write the file" });

  assert.equal(res.text, "done");
  assert.deepEqual(disk.calls.putObject, [{ key: "agent.txt", contentType: undefined }]);
});

function mockModelWithToolCall({
  toolName,
  input,
  finalText,
}: {
  toolName: string;
  input: JsonBody;
  finalText: string;
}): MockLanguageModelV4 {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-tool-caller",
    doGenerate: [
      {
        content: [{ type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: finalText }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    ],
  });
}
