import assert from "node:assert/strict";
import { noopObserve, type ToolExecutionContext } from "@mastra/core/tools";
import { createMockDisk } from "@archildata/mock";
import { test } from "vitest";
import { createDiskTools } from "../src/index.js";

const mastraToolContext: ToolExecutionContext = {
  observe: noopObserve,
};

test("createDiskTools exposes Mastra tools that can be executed", async () => {
  const disk = createMockDisk();
  const tools = createDiskTools(disk);

  assert.deepEqual(
    Object.keys(tools).sort(),
    ["delete_file", "glob", "grep", "list_files", "read_file", "run_bash", "write_file"],
  );
  assert.equal(tools.write_file.id, "write_file");

  assert.ok(tools.write_file.execute);
  await tools.write_file.execute({ path: "/m.txt", content: "from mastra" }, mastraToolContext);
  assert.deepEqual(disk.calls.putObject, [{ key: "m.txt", contentType: undefined }]);
});
