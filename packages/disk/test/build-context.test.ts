import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { packContext } from "../src/build-context.js";

async function context(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archil-context-"));
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), content);
  }
  return root;
}

// The system tar reads the archive back, so a malformed header fails the test.
function list(data: Buffer, verbose = false): string[] {
  return execFileSync("tar", [verbose ? "-tvzf" : "-tzf", "-"], { input: data, env: { ...process.env, TZ: "UTC" } })
    .toString()
    .trim()
    .split("\n");
}

test("packContext leaves out what .dockerignore excludes", async () => {
  const root = await context({
    "app/main.py": "x",
    "app/debug.log": "x",
    "node_modules/left/index.js": "x",
    "build/keep.txt": "x",
    "build/drop.txt": "x",
    "docs/a/b/notes.md": "x",
    "secret.env": "x",
    ".dockerignore": "# dependencies\nnode_modules\n**/*.log\n/build\n!build/keep.txt\ndocs/**/*.md\n*.env\n",
  });

  const { data } = await packContext(root);

  assert.deepEqual(list(data), [".dockerignore", "app/", "app/main.py", "build/keep.txt", "docs/", "docs/a/", "docs/a/b/"]);
});

test("packContext is the same for the same files, whatever their modification times", async () => {
  const root = await context({ "src/main.c": "int main(void) { return 0; }\n" });
  await symlink("src/main.c", join(root, "main.c"));
  const first = await packContext(root);
  await utimes(join(root, "src", "main.c"), 1_000_000, 1_000_000);

  const second = await packContext(root);

  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(second.data, first.data);
  const entries = list(second.data, true);
  assert.ok(entries.some((line) => line.endsWith("main.c -> src/main.c")), entries.join("\n"));
  assert.ok(entries.every((line) => /\b1970\b/.test(line)), entries.join("\n"));
});

test("packContext keeps the executable bit and long paths", async () => {
  const long = `${"nested-directory/".repeat(8)}script-with-a-long-name.sh`;
  const root = await context({ [long]: "#!/bin/sh\n" });
  await chmod(join(root, long), 0o755);

  const entries = list((await packContext(root)).data, true);

  assert.ok(entries.some((line) => line.startsWith("-rwxr-xr-x") && line.endsWith(long)), entries.join("\n"));
});

test("packContext requires a directory", async () => {
  await assert.rejects(packContext(join(tmpdir(), "archil-missing-context")), /not a directory/);
});
