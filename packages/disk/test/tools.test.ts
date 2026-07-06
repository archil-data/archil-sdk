import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "vitest";
import type {
  ExecResult,
  FileSystem,
  GrepOptions,
  GrepResult,
  ListObjectsOptions,
  ListObjectsResult,
  PutObjectResult,
} from "../src/index.js";
import { bindSpecs } from "../src/internal/tools.js";

type BoundTool = ReturnType<typeof bindSpecs>[number];
type BoundToolName = BoundTool["name"];

function getTool<N extends BoundToolName>(
  tools: readonly BoundTool[],
  name: N,
): Extract<BoundTool, { name: N }> {
  const tool = tools.find((spec): spec is Extract<BoundTool, { name: N }> => spec.name === name);
  assert.ok(tool, `expected ${name} tool`);
  return tool;
}

test("bound disk tools read, write, list, glob, and delete files", async () => {
  const fs = new MemoryFs({
    "notes/a.txt": "hello",
    "glob/a.ts": "a",
    "glob/nested/b.ts": "b",
    "glob/nested/c.md": "c",
  });
  const tools = bindSpecs(fs);

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["delete_file", "glob", "grep", "list_files", "read_file", "run_bash", "write_file"],
  );
  assert.deepEqual(await getTool(tools, "read_file").invoke({ path: "/notes/a.txt" }), {
    content: "hello",
    bytes: 5,
  });
  assert.deepEqual(await getTool(tools, "write_file").invoke({ path: "/notes/b.txt", content: "world" }), {
    bytes: 5,
  });
  assert.equal(fs.text("notes/b.txt"), "world");
  assert.deepEqual(await getTool(tools, "list_files").invoke({ path: "/notes" }), {
    entries: [
      { type: "file", path: "/notes/a.txt", bytes: 5 },
      { type: "file", path: "/notes/b.txt", bytes: 5 },
    ],
  });
  assert.deepEqual(await getTool(tools, "glob").invoke({ path: "/glob", pattern: "**/*.ts" }), {
    content: "/glob/a.ts\n/glob/nested/b.ts",
    count: 2,
    path: "/glob",
    truncated: false,
  });
  assert.deepEqual(await getTool(tools, "glob").invoke({ pattern: "/mnt/glob/*.ts" }), {
    content: "/glob/a.ts",
    count: 1,
    path: "/",
    truncated: false,
  });

  await getTool(tools, "delete_file").invoke({ path: "/notes/b.txt" });
  assert.equal(fs.text("notes/b.txt"), undefined);
});

test("bound disk tools return structured errors from expected failures", async () => {
  const out = await getTool(bindSpecs(new MemoryFs()), "read_file").invoke({ path: "/missing.txt" });

  assert.deepEqual(out, {
    error: { message: "file not found", status: 404, path: "/missing.txt" },
  });
});

test("bound grep validates typed options, normalizes paths, and reports status", async () => {
  const fs = new MemoryFs({
    "reports/a.txt": "needle A",
    "reports/b.txt": "other",
  });
  const tools = bindSpecs(fs);
  const grep = getTool(tools, "grep");

  assert.equal(grep.schema.safeParse({ pattern: "x", recursive: "false" }).success, false);
  assert.equal(grep.schema.safeParse({ pattern: "x", maxResults: "50" }).success, false);

  const out = await grep.invoke({
    pattern: "needle",
    path: "/reports",
    recursive: false,
    maxResults: 50,
  });

  assert.deepEqual(fs.grepCalls[0], {
    pattern: "needle",
    directory: "reports",
    recursive: false,
    maxResults: 50,
  });
  assert.deepEqual(out, {
    matches: [{ path: "/reports/a.txt", line: 1, text: "needle A" }],
    status: "Search completed.",
    filesScanned: 2,
  });
});

test("bound tools surface partial list and grep results", async () => {
  const fs = new MemoryFs({ "data/a.txt": "partial-needle" });
  fs.nextListTruncated = true;
  fs.nextGrepStoppedReason = "list_failed";
  const tools = bindSpecs(fs);

  assert.deepEqual(await getTool(tools, "list_files").invoke({ path: "/", recursive: true }), {
    entries: [{ type: "file", path: "/data/a.txt", bytes: 14 }],
    isTruncated: true,
  });
  assert.deepEqual(await getTool(tools, "grep").invoke({ pattern: "partial-needle" }), {
    matches: [{ path: "/data/a.txt", line: 1, text: "partial-needle" }],
    status: "Listing failed for part of the tree; results may be partial.",
    filesScanned: 1,
  });
});

test("bound run_bash executes from the mounted filesystem root", async () => {
  const fs = new MemoryFs();
  const out = await getTool(bindSpecs(fs), "run_bash").invoke({ command: "pwd" });

  assert.deepEqual(fs.execCalls, ["cd /mnt && pwd"]);
  assert.deepEqual(out, {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
  });
});

class MemoryFs implements FileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly grepCalls: GrepOptions[] = [];
  readonly execCalls: string[] = [];
  nextListTruncated = false;
  nextGrepStoppedReason: GrepResult["stoppedReason"] = "completed";

  constructor(files: Record<string, string> = {}) {
    for (const [key, content] of Object.entries(files)) {
      this.files.set(normalizeKey(key), Buffer.from(content));
    }
  }

  async getObject(key: string): Promise<Uint8Array> {
    const normalized = normalizeKey(key);
    const content = this.files.get(normalized);
    if (content === undefined) throw Object.assign(new Error("file not found"), { status: 404 });
    return new Uint8Array(content);
  }

  async putObject(key: string, body: string | Uint8Array | ArrayBuffer): Promise<PutObjectResult> {
    this.files.set(normalizeKey(key), toBytes(body));
    return { etag: '"memory"' };
  }

  async deleteObject(key: string): Promise<void> {
    this.files.delete(normalizeKey(key));
  }

  async listObjects(prefix?: string, opts: ListObjectsOptions = {}): Promise<ListObjectsResult> {
    const normalizedPrefix = prefix === undefined ? "" : normalizePrefix(prefix);
    const objects: ListObjectsResult["objects"] = [];
    const commonPrefixes = new Set<string>();
    for (const [key, content] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.startsWith(normalizedPrefix)) continue;
      if (!opts.recursive) {
        const rest = key.slice(normalizedPrefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          commonPrefixes.add(`${normalizedPrefix}${rest.slice(0, slash + 1)}`);
          continue;
        }
      }
      objects.push({ key, size: content.byteLength });
    }
    return {
      objects,
      commonPrefixes: [...commonPrefixes].sort(),
      isTruncated: this.nextListTruncated,
      keyCount: objects.length,
      prefix: normalizedPrefix,
    };
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    this.grepCalls.push({ ...opts });
    const directory = normalizePrefix(opts.directory ?? "");
    const pattern = new RegExp(opts.pattern);
    const matches: GrepResult["matches"] = [];
    let filesScanned = 0;
    for (const [key, content] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (directory && !key.startsWith(directory)) continue;
      filesScanned += 1;
      const text = Buffer.from(content).toString("utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i])) matches.push({ file: key, line: i + 1, text: lines[i] });
      }
    }
    return grepResult(matches, this.nextGrepStoppedReason, filesScanned);
  }

  async exec(command: string): Promise<ExecResult> {
    this.execCalls.push(command);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
    };
  }

  text(key: string): string | undefined {
    const content = this.files.get(normalizeKey(key));
    return content === undefined ? undefined : Buffer.from(content).toString("utf8");
  }
}

function normalizeKey(key: string): string {
  return key.split("/").filter(Boolean).join("/");
}

function normalizePrefix(prefix: string): string {
  const key = normalizeKey(prefix);
  if (!key) return "";
  return prefix.endsWith("/") ? `${key}/` : key;
}

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  return new Uint8Array(body);
}

function grepResult(
  matches: GrepResult["matches"],
  stoppedReason: GrepResult["stoppedReason"],
  filesScanned: number,
): GrepResult {
  return {
    matches,
    stoppedReason,
    filesScanned,
    containersDispatched: 0,
    computeSecondsUsed: 0,
    durationMs: 0,
    listingMs: 0,
    grepMs: 0,
  };
}
