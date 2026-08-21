import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ApiClient } from "../src/client.js";
import { SandboxFiles } from "../src/sandbox-files.js";
import { SandboxProcess } from "../src/sandbox-process.js";
import { Sandbox } from "../src/sandbox.js";
import { Sandboxes } from "../src/sandboxes.js";

const now = "2026-07-22T12:00:00Z";
const nowDate = new Date(now);

function sandboxWire(status: string = "pending", id: string = "0198-sandbox") {
  return {
    sandbox_id: id,
    name: id === "0198-fork" ? "agent-task" : "prepared-environment",
    status,
    vcpu_count: 2,
    mem_size_mib: 4096,
    base_image: "ubuntu:26.04",
    platform: "arm64",
    max_ttl_seconds: 3600,
    max_concurrent_execs: 8,
    endpoints: [{ port: 8080, hostname: "8080-sandbox.example.com" }],
    created_at: now,
    last_active_at: now,
  };
}

function outputFrame(
  stream: 1 | 2,
  offset: number,
  data: string | Uint8Array,
): ArrayBuffer {
  const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const frame = new Uint8Array(9 + payload.length);
  frame[0] = stream;
  new DataView(frame.buffer).setBigUint64(1, BigInt(offset));
  frame.set(payload, 9);
  return frame.buffer;
}

function ok(data: unknown) {
  return {
    data: { success: true, data },
    response: new Response(null, { status: 200 }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestWebSocket.autoOpen = true;
});

class TestWebSocket {
  static OPEN = 1;
  static instances: TestWebSocket[] = [];
  static autoOpen = true;

  readonly url: string;
  readonly sent: unknown[] = [];
  readyState = 0;
  binaryType = "blob";
  private readonly listeners = new Map<
    string,
    Array<{ listener: (event: any) => void; once: boolean }>
  >();

  constructor(url: string) {
    this.url = url;
    TestWebSocket.instances.push(this);
    if (TestWebSocket.autoOpen) queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: AddEventListenerOptions,
  ) {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      { listener, once: options?.once ?? false },
    ]);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener),
    );
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "", wasClean: true });
  }

  emit(type: string, event: any) {
    if (type === "open") this.readyState = TestWebSocket.OPEN;
    if (type === "close") this.readyState = 3;
    const entries = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      entries.filter((entry) => !entry.once),
    );
    for (const { listener } of entries) listener(event);
  }
}

test("Sandboxes translates list/create inputs and wraps camelCase snapshots", async () => {
  const calls: Array<{ method: string; path: string; options: any }> = [];
  const client = {
    GET: async (path: string, options: unknown) => {
      calls.push({ method: "GET", path, options });
      return ok({ sandboxes: [sandboxWire("running")] });
    },
    POST: async (path: string, options: unknown) => {
      calls.push({ method: "POST", path, options });
      return ok(sandboxWire("running"));
    },
  } as unknown as ApiClient;
  const sandboxes = new Sandboxes(client);

  const listed = await sandboxes.list({ disk: "dsk-0123456789abcdef" });
  assert.equal(listed.length, 1);
  assert.ok(listed[0] instanceof Sandbox);
  assert.ok(listed[0].files instanceof SandboxFiles);
  assert.deepEqual(listed[0].toJSON(), {
    id: "0198-sandbox",
    name: "prepared-environment",
    status: "running",
    vcpuCount: 2,
    memSizeMiB: 4096,
    baseImage: "ubuntu:26.04",
    platform: "arm64",
    maxTtlSeconds: 3600,
    maxConcurrentExecs: 8,
    endpoints: [{ port: 8080, hostname: "8080-sandbox.example.com" }],
    network: undefined,
    createdAt: nowDate,
    runningAt: undefined,
    finishedAt: undefined,
    lastActiveAt: nowDate,
    expiresAt: undefined,
    exitReason: undefined,
  });

  const created = await sandboxes.create({
    name: "prepared-environment",
    vcpuCount: 8,
    memSizeMiB: 16 * 1024,
    baseImage: "ubuntu:26.04",
    env: { NODE_ENV: "test" },
    maxTtlSeconds: 600,
    maxConcurrentExecs: 16,
    network: {
      egress: {
        default: "deny",
        allow: ["github.com", "*.github.com", "140.82.112.0/20"],
        deny: ["169.254.0.0/16"],
      },
    },
  });
  assert.equal(created.status, "running");
  assert.deepEqual(calls, [
    {
      method: "GET",
      path: "/api/sandboxes",
      options: { params: { query: { filesystem: "dsk-0123456789abcdef" } } },
    },
    {
      method: "POST",
      path: "/api/sandboxes",
      options: {
        params: { query: { wait: true } },
        body: {
          name: "prepared-environment",
          vcpu_count: 8,
          mem_size_mib: 16384,
          base_image: "ubuntu:26.04",
          env: { NODE_ENV: "test" },
          max_ttl_seconds: 600,
          max_concurrent_execs: 16,
          network: {
            egress: {
              default: "deny",
              allow: ["github.com", "*.github.com", "140.82.112.0/20"],
              deny: ["169.254.0.0/16"],
            },
          },
        },
      },
    },
  ]);
});

test("Sandboxes treats a null list payload as empty", async () => {
  const client = {
    GET: async () => ok(null),
  } as unknown as ApiClient;
  assert.deepEqual(await new Sandboxes(client).list(), []);
});

test("sandbox snapshots expose API timestamps as Date objects", () => {
  const sandbox = new Sandbox(
    {
      ...sandboxWire("stopped"),
      running_at: now,
      finished_at: now,
      expires_at: now,
    } as any,
    {} as ApiClient,
  );

  assert.ok(sandbox.createdAt instanceof Date);
  assert.ok(sandbox.runningAt instanceof Date);
  assert.ok(sandbox.finishedAt instanceof Date);
  assert.ok(sandbox.lastActiveAt instanceof Date);
  assert.ok(sandbox.expiresAt instanceof Date);
  assert.equal(sandbox.createdAt.toISOString(), "2026-07-22T12:00:00.000Z");
});

test("sandbox snapshots expose the network policy", () => {
  const network = {
    egress: {
      default: "allow" as const,
      allow: ["api.github.com"],
      deny: ["169.254.0.0/16", "*.internal.example"],
    },
  };
  const sandbox = new Sandbox(
    { ...sandboxWire("running"), network } as any,
    {} as ApiClient,
  );

  assert.deepEqual(sandbox.network, network);
  assert.deepEqual(sandbox.toJSON().network, network);
});

test("sandbox lifecycle methods poll only after the server wait expires", async () => {
  vi.useFakeTimers();
  const calls: Array<{ path: string; options: any }> = [];
  const refreshStatuses = ["running", "stopped", "paused", "running"];
  const client = {
    GET: async () => ok(sandboxWire(refreshStatuses.shift() ?? "running")),
    POST: async (path: string, options: unknown) => {
      calls.push({ path, options });
      if (path.endsWith("/stop")) return ok(sandboxWire("stopping"));
      if (path.endsWith("/pause")) return ok(sandboxWire("pausing"));
      return ok(sandboxWire("pending"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.start();
  await vi.advanceTimersByTimeAsync(500);
  assert.equal((await starting).status, "running");
  const stopping = sandbox.stop();
  await vi.advanceTimersByTimeAsync(500);
  assert.equal((await stopping).status, "stopped");
  const pausing = sandbox.pause();
  await vi.advanceTimersByTimeAsync(500);
  assert.equal((await pausing).status, "paused");
  const resuming = sandbox.resume();
  await vi.advanceTimersByTimeAsync(500);
  assert.equal((await resuming).status, "running");
  assert.deepEqual(calls, [
    {
      path: "/api/sandboxes/{sid}/start",
      options: { params: { path: { sid: "0198-sandbox" }, query: { wait: true } } },
    },
    {
      path: "/api/sandboxes/{sid}/stop",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
    {
      path: "/api/sandboxes/{sid}/pause",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
    {
      path: "/api/sandboxes/{sid}/resume",
      options: { params: { path: { sid: "0198-sandbox" }, query: { wait: true } } },
    },
  ]);
});

test("create polls when the server returns a pending sandbox", async () => {
  vi.useFakeTimers();
  let gets = 0;
  const client = {
    POST: async () => ok(sandboxWire("pending")),
    GET: async () => {
      gets++;
      return ok(sandboxWire("running"));
    },
  } as unknown as ApiClient;

  const creating = new Sandboxes(client).create();
  await vi.advanceTimersByTimeAsync(500);
  const sandbox = await creating;

  assert.equal(sandbox.status, "running");
  assert.equal(gets, 1);
});

test("sandbox lifecycle methods can opt out of waiting", async () => {
  const calls: Array<{ path: string; options: any }> = [];
  const client = {
    POST: async (path: string, options: unknown) => {
      calls.push({ path, options });
      if (path.endsWith("/stop")) return ok(sandboxWire("stopping"));
      if (path.endsWith("/pause")) return ok(sandboxWire("pausing"));
      if (path.endsWith("/fork")) return ok(sandboxWire("pending", "0198-fork"));
      return ok(sandboxWire("pending"));
    },
  } as unknown as ApiClient;

  const created = await new Sandboxes(client).create({}, { wait: false });
  await created.start({ wait: false });
  await created.resume({ wait: false });
  assert.equal((await created.stop({ wait: false })).status, "stopping");
  assert.equal((await created.pause({ wait: false })).status, "pausing");
  assert.equal((await created.fork({ wait: false })).status, "pending");

  assert.deepEqual(
    calls.map(({ path, options }) => ({ path, wait: options.params.query?.wait })),
    [
      { path: "/api/sandboxes", wait: false },
      { path: "/api/sandboxes/{sid}/start", wait: false },
      { path: "/api/sandboxes/{sid}/resume", wait: false },
      { path: "/api/sandboxes/{sid}/stop", wait: undefined },
      { path: "/api/sandboxes/{sid}/pause", wait: undefined },
      { path: "/api/sandboxes/{sid}/fork", wait: false },
    ],
  );
});

test("fork creates a named branch and waits for it to start", async () => {
  vi.useFakeTimers();
  let post: { path: string; options: any } | undefined;
  const client = {
    POST: async (path: string, options: unknown) => {
      post = { path, options };
      return ok(sandboxWire("pending", "0198-fork"));
    },
    GET: async () => ok(sandboxWire("running", "0198-fork")),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("stopped") as any, client);

  const forking = sandbox.fork({ name: "agent-task" });
  await vi.advanceTimersByTimeAsync(500);
  const fork = await forking;

  assert.equal(fork.id, "0198-fork");
  assert.equal(fork.name, "agent-task");
  assert.equal(fork.status, "running");
  assert.deepEqual(post, {
    path: "/api/sandboxes/{sid}/fork",
    options: {
      params: { path: { sid: "0198-sandbox" }, query: { wait: true } },
      body: { name: "agent-task" },
    },
  });
});

test("sandbox delete accepts 204", async () => {
  const calls: Array<{ method: string; path: string; options: any }> = [];
  const client = {
    DELETE: async (path: string, options: unknown) => {
      calls.push({ method: "DELETE", path, options });
      return { response: new Response(null, { status: 204 }) };
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("stopped") as any, client);

  await sandbox.delete();

  assert.deepEqual(calls, [
    {
      method: "DELETE",
      path: "/api/sandboxes/{sid}",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
  ]);
});

test("exec starts a process and waits for its result", async () => {
  const calls: Array<{ path: string; options: any }> = [];
  const client = {
    POST: async (path: string, options: any) => {
      calls.push({ path, options });
      return ok({
        url: "wss://sandbox.example/connect?token=signed",
        expires_at: now,
      });
    },
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const executing = sandbox.exec("printf hello", {
    env: { HELLO: "world" },
    timeoutSeconds: 10,
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  socket.emit("message", { data: outputFrame(1, 0, "hello") });
  socket.emit("message", {
    data: JSON.stringify({
      type: "exit",
      status: "completed",
      exit_code: 0,
      cursor: 5,
    }),
  });

  assert.deepEqual(await executing, {
    status: "completed",
    exitCode: 0,
    exitReason: undefined,
    stdout: "hello",
    stderr: "",
  });
  assert.deepEqual(calls, [
    {
      path: "/api/sandboxes/{sid}/connections",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
  ]);
  assert.deepEqual(JSON.parse(socket.sent[0] as string), {
    type: "start",
    command: "printf hello",
    env: { HELLO: "world" },
    timeout_seconds: 10,
  });
});

test("processes start directly, disconnect, and resume from their output cursor", async () => {
  const calls: Array<{ path: string; options: any }> = [];
  const output: Array<{ stream: string; offset: number; data: number[] }> = [];
  const client = {
    POST: async (path: string, options: any) => {
      calls.push({ path, options });
      return ok({
        url: "wss://sandbox.example/connect?token=signed",
        expires_at: now,
      });
    },
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.processes.start("echo hello", {
    terminal: false,
    env: { HELLO: "world" },
    timeoutSeconds: 10,
    onOutput: (event) =>
      output.push({
        stream: event.stream,
        offset: event.offset,
        data: Array.from(event.data),
      }),
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const first = TestWebSocket.instances[0];
  first.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  const process = await starting;

  assert.ok(process instanceof SandboxProcess);
  assert.equal(process.id, "0198-process");
  assert.equal(process.cursor, 0);
  assert.equal(process.connected, true);
  assert.equal(
    first.url,
    "wss://sandbox.example/connect?token=signed",
  );
  assert.deepEqual(JSON.parse(first.sent[0] as string), {
    type: "start",
    command: "echo hello",
    terminal: false,
    env: { HELLO: "world" },
    timeout_seconds: 10,
  });

  first.emit("message", { data: outputFrame(1, 0, "hello\n") });
  await vi.waitFor(() => assert.equal(process.cursor, 6));
  await process.sendInput("more\n");
  await process.closeStdin();
  assert.equal(new TextDecoder().decode(first.sent[1] as Uint8Array), "more\n");
  assert.deepEqual(JSON.parse(first.sent[2] as string), { type: "close_stdin" });
  await process.disconnect();
  assert.equal(process.connected, false);

  const connecting = sandbox.processes.connect(process.id, {
    offset: process.cursor,
    onOutput: (event) =>
      output.push({
        stream: event.stream,
        offset: event.offset,
        data: Array.from(event.data),
      }),
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances.length, 2));
  const resumed = TestWebSocket.instances[1];
  await vi.waitFor(() => assert.equal(resumed.sent.length, 1));
  assert.deepEqual(JSON.parse(resumed.sent[0] as string), {
    type: "attach",
    process_id: "0198-process",
    offset: 6,
  });
  resumed.emit("message", {
    data: JSON.stringify({ type: "attached", process_id: "0198-process" }),
  });
  const resumedProcess = await connecting;
  const waiting = resumedProcess.wait();
  resumed.emit("message", { data: outputFrame(2, 6, "warning\n") });
  resumed.emit("message", {
    data: JSON.stringify({
      type: "exit",
      status: "completed",
      exit_code: 0,
      cursor: 14,
    }),
  });
  resumed.emit("close", { code: 1000, reason: "process exited with code 0" });

  assert.deepEqual(await waiting, {
    status: "completed",
    exitCode: 0,
    exitReason: undefined,
    stdout: "",
    stderr: "warning\n",
  });
  assert.equal(process.status, "running");
  assert.equal(process.cursor, 6);
  assert.equal(resumedProcess.status, "completed");
  assert.equal(resumedProcess.cursor, 14);
  assert.deepEqual(output, [
    {
      stream: "stdout",
      offset: 0,
      data: Array.from(new TextEncoder().encode("hello\n")),
    },
    {
      stream: "stderr",
      offset: 6,
      data: Array.from(new TextEncoder().encode("warning\n")),
    },
  ]);
  assert.deepEqual(calls, [
    {
      path: "/api/sandboxes/{sid}/connections",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
    {
      path: "/api/sandboxes/{sid}/connections",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
  ]);
});

test("processes reconnect by ID and an explicit output cursor", async () => {
  const output: Array<{ stream: string; offset: number; data: number[] }> = [];
  const client = {
    POST: async () =>
      ok({
        url: "wss://sandbox.example/connect",
        expires_at: now,
      }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const connecting = sandbox.processes.connect("0198-process", {
    offset: 1_000,
    onOutput: (event) =>
      output.push({
        stream: event.stream,
        offset: event.offset,
        data: Array.from(event.data),
      }),
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  assert.deepEqual(JSON.parse(socket.sent[0] as string), {
    type: "attach",
    process_id: "0198-process",
    offset: 1_000,
  });
  socket.emit("message", {
    data: JSON.stringify({ type: "attached", process_id: "0198-process" }),
  });
  const process = await connecting;

  socket.emit("message", { data: outputFrame(1, 1024, "retained\n") });
  socket.emit("message", {
    data: JSON.stringify({
      type: "exit",
      status: "completed",
      exit_code: 0,
      cursor: 1033,
    }),
  });
  socket.emit("close", { code: 1000, reason: "process exited with code 0" });

  assert.deepEqual(await process.wait(), {
    status: "completed",
    exitCode: 0,
    exitReason: undefined,
    stdout: "retained\n",
    stderr: "",
  });
  assert.equal(process.cursor, 1033);
  assert.deepEqual(output, [
    {
      stream: "stdout",
      offset: 1024,
      data: Array.from(new TextEncoder().encode("retained\n")),
    },
  ]);
});

test("a terminal is a process with terminal sizing, input, and kill", async () => {
  const client = {
    POST: async () =>
      ok({
        url: "wss://sandbox.example/connect?token=signed",
        expires_at: now,
      }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.processes.start("codex", {
    terminal: { cols: 132, rows: 43 },
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  const process = await starting;

  assert.deepEqual(JSON.parse(socket.sent[0] as string), {
    type: "start",
    command: "codex",
    terminal: { cols: 132, rows: 43 },
    env: {},
  });

  await process.sendInput("Review this repository\n");
  await process.sendInput(new Uint8Array([3]));
  const resizing = process.resize({ cols: 160, rows: 50 });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances.length, 2));
  const resizeSocket = TestWebSocket.instances[1];
  await vi.waitFor(() => assert.equal(resizeSocket.sent.length, 1));
  resizeSocket.emit("message", {
    data: JSON.stringify({ type: "resized" }),
  });
  await resizing;
  const killing = process.kill();
  await vi.waitFor(() => assert.equal(TestWebSocket.instances.length, 3));
  const killSocket = TestWebSocket.instances[2];
  await vi.waitFor(() => assert.equal(killSocket.sent.length, 1));
  assert.equal(socket.sent[1] instanceof Uint8Array, true);
  assert.equal(socket.sent[2] instanceof Uint8Array, true);
  assert.equal(
    new TextDecoder().decode(socket.sent[1] as Uint8Array),
    "Review this repository\n",
  );
  assert.deepEqual(socket.sent[2], new Uint8Array([3]));
  assert.deepEqual(JSON.parse(resizeSocket.sent[0] as string), {
    type: "resize",
    process_id: "0198-process",
    cols: 160,
    rows: 50,
  });
  assert.deepEqual(JSON.parse(killSocket.sent[0] as string), {
    type: "kill",
    process_id: "0198-process",
  });
  killSocket.emit("message", {
    data: JSON.stringify({
      type: "killed",
    }),
  });
  assert.equal(await killing, undefined);
  await process.disconnect();
});

test("process input is streamed as ordered WebSocket frames", async () => {
  const output: Array<{ stream: string; offset: number; data: string }> = [];
  const client = {
    POST: async () =>
      ok({
        url: "wss://sandbox.example/connect?token=signed",
        expires_at: now,
      }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.processes.start("cat", {
    onOutput: (event) =>
      output.push({
        stream: event.stream,
        offset: event.offset,
        data: new TextDecoder().decode(event.data),
      }),
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  const process = await starting;
  const input = new Uint8Array(2 * 1024 * 1024 + 3);
  input.fill(7);

  await process.sendInput(input);
  socket.emit("message", { data: outputFrame(1, 0, "output\n") });
  await vi.waitFor(() => assert.equal(process.cursor, 7));
  assert.equal(process.cursor, 7);
  assert.deepEqual(output, [{ stream: "stdout", offset: 0, data: "output\n" }]);

  const chunks = socket.sent.slice(1) as Uint8Array[];
  assert.deepEqual(
    chunks.map((chunk) => chunk.byteLength),
    [1024 * 1024, 1024 * 1024, 3],
  );
  assert.equal(process.connected, true);
});

test("failed stdin close can be retried", async () => {
  const client = {
    POST: async () =>
      ok({
        url: "wss://sandbox.example/connect",
        expires_at: now,
      }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.processes.start("cat");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  const process = await starting;

  const send = socket.send.bind(socket);
  socket.send = () => {
    throw new Error("send failed");
  };
  await assert.rejects(process.closeStdin(), /send failed/);

  socket.send = send;
  await process.closeStdin();
  assert.deepEqual(JSON.parse(socket.sent[1] as string), { type: "close_stdin" });
});

test("process exit closes stdin locally", async () => {
  const client = {
    POST: async () =>
      ok({
        url: "wss://sandbox.example/connect",
        expires_at: now,
      }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.processes.start("cat");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  const process = await starting;

  await process.sendInput("input");
  socket.emit("message", {
    data: JSON.stringify({
      type: "exit",
      status: "completed",
      exit_code: 0,
      cursor: 0,
    }),
  });

  assert.equal((await process.wait()).status, "completed");
  await assert.rejects(process.sendInput("later"), /stdin is closed/);
});

test("output callbacks cannot hide runtime connection errors", async () => {
  const client = {
    POST: async () =>
      ok({
        url: "wss://sandbox.example/connect",
        expires_at: now,
      }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.processes.start("echo hello", {
    onOutput: () => {
      throw new Error("callback failed");
    },
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  const process = await starting;

  assert.throws(
    () => socket.emit("message", { data: outputFrame(1, 0, "hello\n") }),
    /callback failed/,
  );
  assert.equal(process.connected, true);

  const waiting = process.wait();
  socket.emit("message", {
    data: JSON.stringify({
      type: "error",
      error: "process_failed",
      message: "specific runtime failure",
    }),
  });
  await assert.rejects(waiting, /process_failed: specific runtime failure/);
});

test("process output collection can be disabled while streaming", async () => {
  const client = {
    POST: async () =>
      ok({
        url: "wss://sandbox.example/connect",
        expires_at: now,
      }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);
  const output: string[] = [];

  const starting = sandbox.processes.start("echo hello", {
    collectOutput: false,
    onOutput: ({ data }) => output.push(new TextDecoder().decode(data)),
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.emit("message", {
    data: JSON.stringify({ type: "started", process_id: "0198-process" }),
  });
  const process = await starting;

  socket.emit("message", { data: outputFrame(1, 0, "hello\n") });
  socket.emit("message", {
    data: JSON.stringify({
      type: "exit",
      status: "completed",
      exit_code: 0,
      cursor: 6,
    }),
  });

  assert.deepEqual(output, ["hello\n"]);
  assert.deepEqual(await process.wait(), {
    status: "completed",
    exitCode: 0,
    exitReason: undefined,
    stdout: "",
    stderr: "",
  });
});

test("process start surfaces runtime rejection", async () => {
  const client = {
    POST: async () => ok({ url: "wss://sandbox.example/connect", expires_at: now }),
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.processes.start("");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  TestWebSocket.instances[0].emit("message", {
    data: JSON.stringify({
      type: "error",
      error: "invalid_request",
      message: "command is required",
    }),
  });

  await assert.rejects(starting, /invalid_request: command is required/);
});

test("sandbox instance methods use the owning sandbox id", async () => {
  const calls: Array<{ method: string; path: string; options: any }> = [];
  const client = {
    GET: async (path: string, options: unknown) => {
      calls.push({ method: "GET", path, options });
      return ok(sandboxWire("running"));
    },
    POST: async (path: string, options: unknown) => {
      calls.push({ method: "POST", path, options });
      return ok(sandboxWire("stopped"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  assert.equal((await sandbox.refresh()).status, "running");
  assert.equal((await sandbox.stop()).status, "stopped");

  for (const call of calls) {
    assert.equal(call.options.params.path.sid, "0198-sandbox");
  }
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/api/sandboxes/{sid}/stop",
    options: { params: { path: { sid: "0198-sandbox" } } },
  });
});
