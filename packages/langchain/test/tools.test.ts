import assert from "node:assert/strict";
import { createMockDisk } from "@archildata/mock";
import { test } from "vitest";
import { createDiskTools } from "../src/index.js";

test("createDiskTools exposes LangChain structured tools that can be invoked", async () => {
  const disk = createMockDisk();
  const tools = createDiskTools(disk);

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["delete_file", "glob", "grep", "list_files", "read_file", "run_bash", "write_file"],
  );

  const writeFile = tools.find((tool) => tool.name === "write_file");
  assert.ok(writeFile);
  await writeFile.invoke({ path: "/lc.txt", content: "from lc" });
  assert.deepEqual(disk.calls.putObject, [{ key: "lc.txt", contentType: undefined }]);
});
