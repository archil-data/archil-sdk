// Exercises the agent-tools adapters end-to-end: a stubbed global fetch emulates
// the control-plane and S3 gateway, and the tools run through the real
// Disk/Workspace methods, path routing, and framework wrappers (Vercel AI SDK +
// Mastra + LangChain), including multi-disk workspace routing.

import { test } from "vitest";
import assert from "node:assert/strict";
import { generateText, stepCountIs } from "ai";
import { Archil, Workspace } from "../src/index.js";
import * as aiSdk from "../src/ai-sdk.js";
import * as mastra from "../src/mastra.js";
import * as langchain from "../src/langchain.js";

type Store = Record<string, string>;
type Stores = Record<string, Store>;
type JsonBody = Record<string, any>;

const stores: Stores = { "dsk-1": {}, "dsk-2": {} };
const names: Record<string, string> = { "dsk-1": "alpha", "dsk-2": "beta" };
let lastExec: any;
let lastGrepBody: any;
let grepStoppedReason = "completed";

const mastraToolContext = {
  observe: {
    span: async <T>(_name: string, fn: () => T | Promise<T>) => fn(),
    log: () => {},
  },
};

function json(obj: JsonBody, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
const execData = (where: string) => ({ exitCode: 0, stdout: `ran on ${where}`, stderr: "", timing: { totalMs: 1, queueMs: 0, executeMs: 1 } });

function listXml(store: Store, prefix: string, delimiter: string | null) {
  let contents = "";
  const common = new Set<string>();
  for (const key of Object.keys(store).sort()) {
    if (prefix && !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (delimiter && rest.includes(delimiter)) {
      common.add(prefix + rest.split(delimiter)[0] + delimiter);
      continue;
    }
    contents += `<Contents><Key>${key}</Key><Size>${store[key].length}</Size></Contents>`;
  }
  const cps = [...common].sort().map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("");
  return `<?xml version="1.0"?><ListBucketResult><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Prefix>${prefix}</Prefix>${contents}${cps}</ListBucketResult>`;
}

globalThis.fetch = async (input, init = {}) => {
  // openapi-fetch calls fetch with a Request object, so method/body live there,
  // not on init. Normalize both call shapes to a Request.
  const req = input instanceof Request ? input : new Request(input, init);
  const u = new URL(req.url);
  const method = req.method.toUpperCase();
  const bodyToString = () => req.text();
  if (u.host === "cp.test") {
    if (u.pathname === "/api/exec") {
      lastExec = JSON.parse(await bodyToString());
      return json({ success: true, data: execData("workspace") });
    }
    if (u.pathname.endsWith("/exec")) {
      const id = u.pathname.split("/")[3] ?? "";
      lastExec = { disk: id };
      return json({ success: true, data: execData(id) });
    }
    if (u.pathname.endsWith("/grep")) {
      const id = u.pathname.split("/")[3] ?? "";
      const body = JSON.parse(await bodyToString());
      lastGrepBody = body;
      const matches = Object.entries(stores[id])
        .filter(([, v]) => v.includes(body.pattern))
        .map(([k, v]) => ({ file: k, line: 1, text: v }));
      return json({ success: true, data: { matches, stoppedReason: grepStoppedReason, filesScanned: 1, containersDispatched: 1, computeSecondsUsed: 0.1, durationMs: 1, listingMs: 0, grepMs: 1 } });
    }
    const id = u.pathname.split("/").pop() ?? "";
    return json({ success: true, data: { id, name: names[id], organization: "o", status: "available", provider: "aws", region: "aws-us-east-1", createdAt: "2026-01-01T00:00:00Z" } });
  }
  // s3.test
  const diskId = u.pathname.split("/")[1] ?? "";
  const store = stores[diskId];
  const key = decodeURIComponent(u.pathname.split("/").slice(2).join("/"));
  if (method === "PUT") {
    store[key] = await bodyToString();
    return new Response(null, { status: 200, headers: { etag: '"x"' } });
  }
  if (method === "DELETE") {
    delete store[key];
    return new Response(null, { status: 204 });
  }
  if (method === "GET" && key === "") {
    return new Response(listXml(store, u.searchParams.get("prefix") || "", u.searchParams.get("delimiter")), { status: 200 });
  }
  if (method === "GET" || method === "HEAD") {
    if (!(key in store)) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return new Response(store[key], { status: 200 });
  }
  return new Response(null, { status: 400 });
};

function newClient() {
  return new Archil({ apiKey: "key-test", region: "aws-us-east-1", baseUrl: "http://cp.test", s3BaseUrl: "http://s3.test" });
}

test("ai-sdk: single disk write then read, /mnt stripped to key", async () => {
  const archil = newClient();
  const disk = await archil.disks.get("dsk-1");
  const tools = aiSdk.createDiskTools(disk);
  assert.deepEqual(
    Object.keys(tools).sort(),
    ["delete_file", "grep", "list_files", "read_file", "run_bash", "write_file"],
  );
  const wrote = await tools.write_file.execute({ path: "/notes/a.txt", content: "hello" });
  assert.deepEqual(wrote, { bytes: 5 });
  assert.equal(stores["dsk-1"]["notes/a.txt"], "hello");
  assert.deepEqual(await tools.read_file.execute({ path: "/notes/a.txt" }), {
    content: "hello",
    bytes: 5,
  });
});

test("ai-sdk: missing file returns a readable error", async () => {
  const disk = await newClient().disks.get("dsk-1");
  const out = await aiSdk.createDiskTools(disk).read_file.execute({ path: "/nope.txt" });
  assert.deepEqual(out, { error: { message: "file not found", status: 404, path: "/nope.txt" } });
});

test("workspace: an unknown disk in the path is rejected", async () => {
  const archil = newClient();
  const ws = archil.workspace({ data: await archil.disks.get("dsk-1") });
  const out = await aiSdk.createDiskTools(ws).read_file.execute({ path: "/nope/x.txt" });
  assert.match((out as any).error.message.toLowerCase(), /no disk named/);
});

test("langchain: tools invoke through the real handler", async () => {
  const disk = await newClient().disks.get("dsk-1");
  const tools = Object.fromEntries(langchain.createDiskTools(disk).map((t) => [t.name, t])) as Record<string, any>;
  await tools.write_file.invoke({ path: "/lc.txt", content: "from lc" });
  assert.deepEqual(await tools.read_file.invoke({ path: "/lc.txt" }), {
    content: "from lc",
    bytes: 7,
  });
});

test("workspace: writes route by path, grep fans out across disks", async () => {
  const archil = newClient();
  const ws = archil.workspace({ data: await archil.disks.get("dsk-1"), cache: await archil.disks.get("dsk-2") });
  const tools = aiSdk.createDiskTools(ws);

  await tools.write_file.execute({ path: "/data/x.txt", content: "needle A" });
  await tools.write_file.execute({ path: "/cache/y.txt", content: "needle B" });
  assert.equal(stores["dsk-1"]["x.txt"], "needle A");
  assert.equal(stores["dsk-2"]["y.txt"], "needle B");

  const grep = await tools.grep.execute({ pattern: "needle" }) as any;
  assert.deepEqual(grep.matches.map((m: any) => m.path).sort(), ["/cache/y.txt", "/data/x.txt"]);

  await tools.run_bash.execute({ command: "ls" });
  assert.deepEqual(Object.keys(lastExec.disks).sort(), ["cache", "data"]);
});

test("exec: multi-disk mount specs forward checkout paths", async () => {
  const archil = newClient();
  const disk = await archil.disks.get("dsk-1");
  await archil.exec({
    command: "npm test",
    disks: {
      data: {
        disk,
        checkoutPaths: ["src", "tmp/cache"],
        queueMs: 250,
        conditional: true,
      },
    },
  });

  assert.deepEqual(lastExec.disks.data.checkoutPaths, ["src", "tmp/cache"]);
  assert.equal(lastExec.disks.data.queueMs, 250);
  assert.equal(lastExec.disks.data.conditional, true);
});

test("workspace: list_files at the root shows the disks, not their contents", async () => {
  const archil = newClient();
  stores["dsk-1"]["deep/file.txt"] = "x";
  const ws = archil.workspace({ data: await archil.disks.get("dsk-1"), cache: await archil.disks.get("dsk-2") });
  const out = await aiSdk.createDiskTools(ws).list_files.execute({ path: "/" }) as any;
  assert.deepEqual(out.entries, [
    { type: "dir", path: "/cache/" },
    { type: "dir", path: "/data/" },
  ]);
  // A non-recursive root listing names the disks; it doesn't recurse into them.
  assert.equal(out.entries.some((entry: any) => entry.path.includes("file.txt")), false);
});

test("mastra: builds a keyed tool record over the disk", async () => {
  const disk = await newClient().disks.get("dsk-1");
  const tools = mastra.createDiskTools(disk);
  assert.deepEqual(Object.keys(tools).sort(), ["delete_file", "grep", "list_files", "read_file", "run_bash", "write_file"]);
  assert.equal(tools.read_file.id, "read_file");

  // execute must forward the validated input to the handler. Mastra passes the
  // input directly (1.x); our adapter's defensive read also accepts the older
  // { context } shape.
  const wrote = await tools.write_file.execute!(
    { path: "/m.txt", content: "from mastra" },
    mastraToolContext,
  );
  assert.deepEqual(wrote, { bytes: 11 });
  assert.equal(stores["dsk-1"]["m.txt"], "from mastra");
});

test("grep: schema requires typed optional arguments", async () => {
  const disk = await newClient().disks.get("dsk-1");
  const schema = (aiSdk.createDiskTools(disk).grep as any).inputSchema;
  assert.equal(schema.safeParse({ pattern: "x", recursive: "false" }).success, false);
  assert.equal(schema.safeParse({ pattern: "x", maxResults: "50" }).success, false);
});

test("grep: typed optional arguments are forwarded", async () => {
  const disk = await newClient().disks.get("dsk-1");
  const out = await aiSdk.createDiskTools(disk).grep.execute({ pattern: "x", recursive: false, maxResults: 50 });
  assert.equal("error" in out, false);
  assert.equal(lastGrepBody.recursive, false);
  assert.equal(lastGrepBody.maxResults, 50);
});

test("grep: a single-disk directory path is normalized like the other tools", async () => {
  const disk = await newClient().disks.get("dsk-1");
  // "/reports" must reach the grep API as the disk-relative key "reports",
  // matching how read_file/write_file/list_files normalize the same path.
  await aiSdk.createDiskTools(disk).grep.execute({ pattern: "x", path: "/reports" });
  assert.equal(lastGrepBody.directory, "reports");
});

test("workspace: removeDisk refuses to drop the last disk", async () => {
  const archil = newClient();
  const ws = archil.workspace({ data: await archil.disks.get("dsk-1") });
  assert.throws(() => ws.removeDisk("data"), /last disk/);
  assert.deepEqual(ws.diskNames(), ["data"]);
});

test("list_files surfaces a partial-listing caveat when a workspace disk failed", async () => {
  // isTruncated from a resilient fan-out (a disk errored) must reach the agent.
  const fakeWs = {
    diskNames: () => ["data", "cache"],
    listObjects: async () => ({
      objects: [{ key: "data/a.txt", size: 1 }],
      commonPrefixes: [],
      isTruncated: true,
      keyCount: 1,
    }),
  } as unknown as Workspace;
  const out = await aiSdk.createDiskTools(fakeWs).list_files.execute({ path: "/" });
  assert.deepEqual(out, {
    entries: [{ type: "file", path: "/data/a.txt", bytes: 1 }],
    isTruncated: true,
  });
});

test("grep: a failed listing surfaces a partial-results warning", async () => {
  grepStoppedReason = "list_failed";
  try {
    stores["dsk-1"]["grep-hit.txt"] = "partial-needle";
    const disk = await newClient().disks.get("dsk-1");
    const out = await aiSdk.createDiskTools(disk).grep.execute({ pattern: "partial-needle" }) as any;
    assert.deepEqual(out.matches, [{ path: "/grep-hit.txt", line: 1, text: "partial-needle" }]);
    assert.equal(out.status, "Listing failed for part of the tree; results may be partial.");
  } finally {
    grepStoppedReason = "completed";
  }
});

// A minimal LanguageModelV2 (AI SDK v5) mock that emits a scripted tool call on
// the first turn, then a final text — so generateText runs its real agent loop
// (parse tool call -> invoke OUR tool -> feed result back) deterministically,
// with no real model. Hand-rolled because `ai/test` drags in vitest+msw.
function mockToolThenText({
  toolName,
  input,
  finalText,
}: {
  toolName: string;
  input: JsonBody;
  finalText: string;
}): any {
  let calls = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-tool-caller",
    supportedUrls: {},
    async doGenerate() {
      calls += 1;
      if (calls === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) }],
          finishReason: "tool-calls",
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: "text", text: finalText }], finishReason: "stop", usage, warnings: [] };
    },
  };
}

test("ai-sdk: a mock model's tool call drives our tool through generateText", async () => {
  const archil = newClient();
  const disk = await archil.disks.get("dsk-1");
  const tools = aiSdk.createDiskTools(disk);
  const model = mockToolThenText({
    toolName: "write_file",
    input: { path: "/agent.txt", content: "written by the agent" },
    finalText: "done",
  });

  const res = await generateText({ model, tools: tools as any, stopWhen: stepCountIs(4), prompt: "write the file" });

  // The AI SDK parsed the tool call, validated it against OUR zod schema,
  // invoked OUR tool, and it hit the (mocked) disk:
  assert.equal(stores["dsk-1"]["agent.txt"], "written by the agent");
  // …and a tool result flowed back so the loop produced a final answer:
  assert.equal(res.text, "done");
  const toolResults = res.steps.flatMap((s) => s.toolResults ?? []);
  assert.ok(
    toolResults.some((r) => {
      const output = r.output as any;
      return output?.bytes === "written by the agent".length;
    }),
    `expected a write_file tool result, got: ${JSON.stringify(toolResults)}`,
  );
});

test("mastra: a mock model's tool call drives our tool through Agent.generate", async () => {
  const { Agent } = await import("@mastra/core/agent");
  const archil = newClient();
  const disk = await archil.disks.get("dsk-1");
  const tools = mastra.createDiskTools(disk);
  // Mastra 1.x runs its loop on AI SDK 5+, so it takes the same v2 mock.
  const model = mockToolThenText({
    toolName: "write_file",
    input: { path: "/mastra-agent.txt", content: "by mastra agent" },
    finalText: "done",
  });

  const agent = new Agent({ name: "t", instructions: "write files when asked", model, tools } as any);
  await agent.generate("write the file");

  assert.equal(stores["dsk-1"]["mastra-agent.txt"], "by mastra agent");
});

test("workspace: nested mount names are rejected", async () => {
  const archil = newClient();
  const disk = await archil.disks.get("dsk-1");
  // A "/" in a mount name is ambiguous with routing, so it's rejected up front.
  assert.throws(() => archil.workspace({ "a/b": disk }), /must not contain/);
});

test("workspace: run_bash preserves the conditional mount flag", async () => {
  const archil = newClient();
  const ws = archil.workspace({ data: { disk: await archil.disks.get("dsk-1"), conditional: true } });
  await aiSdk.createDiskTools(ws).run_bash.execute({ command: "ls" });
  assert.equal(lastExec.disks.data.conditional, true);
});

test("workspace: run_bash preserves checkout mount options", async () => {
  const archil = newClient();
  const ws = archil.workspace({
    data: {
      disk: await archil.disks.get("dsk-1"),
      checkoutPaths: ["src", "tmp/cache"],
      queueMs: 250,
    },
  });
  await aiSdk.createDiskTools(ws).run_bash.execute({ command: "ls" });
  assert.deepEqual(lastExec.disks.data.checkoutPaths, ["src", "tmp/cache"]);
  assert.equal(lastExec.disks.data.queueMs, 250);
});

test("workspace: read-only mount blocks writes", async () => {
  const archil = newClient();
  const ws = archil.workspace({ data: { disk: await archil.disks.get("dsk-1"), readOnly: true } });
  const out = await aiSdk.createDiskTools(ws).write_file.execute({ path: "/data/z.txt", content: "z" });
  assert.match((out as any).error.message.toLowerCase(), /read-only/);
});
