import assert from "node:assert/strict";
import { createMockDisk } from "@archildata/mock";
import type { DynamicResolveContext, DynamicToolEntry, DynamicToolSet } from "eve/tools";
import { test } from "vitest";
import { createDiskTools } from "../src/tools.js";

type DiskToolSet = DynamicToolSet & {
  bash: DynamicToolEntry<{ command: string }, unknown>;
};

const dynamicResolveContext: DynamicResolveContext = {
  session: {
    id: "test-session",
    auth: { current: null, initiator: null },
  },
  channel: {},
  messages: [],
};

const toolContext: Parameters<DynamicToolEntry["execute"]>[1] = {
  abortSignal: new AbortController().signal,
  session: {
    id: "test-session",
    auth: { current: null, initiator: null },
    turn: { id: "test-turn", sequence: 0 },
  },
  getSandbox: async () => {
    throw new Error("not used");
  },
  getSkill: () => {
    throw new Error("not used");
  },
};

async function resolveTools(input: Parameters<typeof createDiskTools>[0]): Promise<DiskToolSet> {
  const handler = createDiskTools(input).events["session.started"];
  if (typeof handler !== "function") {
    assert.fail("expected session.started dynamic tool handler");
  }
  const tools = await handler(undefined, dynamicResolveContext);
  assertDiskToolSet(tools);
  return tools;
}

function assertDiskToolSet(tools: unknown): asserts tools is DiskToolSet {
  assert.ok(tools && typeof tools === "object" && "bash" in tools);
}

test("createDiskTools exposes Eve dynamic tools that can be executed", async () => {
  const disk = createMockDisk();
  const tools = await resolveTools(disk);

  assert.deepEqual(
    Object.keys(tools).sort(),
    ["bash", "delete_file", "glob", "grep", "list_files", "read_file", "write_file"],
  );

  await tools.bash.execute({ command: "pwd" }, toolContext);
  assert.deepEqual(disk.calls.exec, ["cd /mnt && pwd"]);
});
