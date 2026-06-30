import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockDisk, createMockWorkspace } from "@archildata/mock";
import type { DynamicToolEntry, DynamicToolSet } from "eve/tools";
import { createDiskTools } from "../src/tools.js";

type DiskToolSet = DynamicToolSet & {
  read_file: DynamicToolEntry<{ path: string }, unknown>;
  write_file: DynamicToolEntry<{ path: string; content: string }, unknown>;
  glob: DynamicToolEntry<{ path?: string; pattern: string }, { content: string; count: number }>;
  grep: DynamicToolEntry<{ pattern: string }, { matches: Array<{ path: string }> }>;
  bash: DynamicToolEntry<{ command: string }, unknown>;
};

async function resolveTools(input: Parameters<typeof createDiskTools>[0]): Promise<DiskToolSet> {
  const handler = createDiskTools(input).events["session.started"];
  if (typeof handler !== "function") {
    assert.fail("expected session.started dynamic tool handler");
  }
  const tools = await handler(undefined, undefined as never);
  assert.ok(isRecord(tools));
  return tools as DiskToolSet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("createDiskTools exposes Eve dynamic disk tools", async () => {
  const disk = createMockDisk({ files: { "notes/a.txt": "hello" } });
  const tools = await resolveTools(disk);

  assert.deepEqual(
    Object.keys(tools).sort(),
    ["bash", "delete_file", "glob", "grep", "list_files", "read_file", "write_file"],
  );
  assert.deepEqual(await tools.glob.execute({ path: "/notes", pattern: "*.txt" }, undefined as never), {
    content: "/notes/a.txt",
    count: 1,
    path: "/notes",
    truncated: false,
  });
  assert.deepEqual(await tools.read_file.execute({ path: "/notes/a.txt" }, undefined as never), {
    content: "hello",
    bytes: 5,
  });

  assert.deepEqual(await tools.write_file.execute({ path: "/notes/b.txt", content: "world" }, undefined as never), {
    bytes: 5,
  });
  assert.equal(disk.getText("notes/b.txt"), "world");
});

test("createDiskTools returns structured errors from disk failures", async () => {
  const disk = createMockDisk();
  const tools = await resolveTools(disk);

  assert.deepEqual(await tools.read_file.execute({ path: "/missing.txt" }, undefined as never), {
    error: { message: "file not found", status: 404, path: "/missing.txt" },
  });
});

test("createDiskTools routes workspace paths and exec mounts", async () => {
  const data = createMockDisk({ files: { "a.txt": "needle A" } });
  const cache = createMockDisk({ files: { "b.txt": "needle B" } });
  const workspace = createMockWorkspace({ data, cache });
  const tools = await resolveTools(workspace);

  const grep = await tools.grep.execute({ pattern: "needle" }, undefined as never);
  assert.deepEqual(grep.matches.map((match) => match.path).sort(), ["/cache/b.txt", "/data/a.txt"]);

  await tools.write_file.execute({ path: "/data/c.txt", content: "new" }, undefined as never);
  assert.equal(data.getText("c.txt"), "new");

  await tools.bash.execute({ command: "ls" }, undefined as never);
  assert.deepEqual(Object.keys(workspace.execCalls[0].disks).sort(), ["cache", "data"]);
});
