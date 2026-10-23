import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createApiClient, type ApiClient } from "../src/client.js";
import { ArchilApiError, SandboxPauseError } from "../src/errors.js";
import { Disks } from "../src/disks.js";
import { SandboxFiles } from "../src/sandbox-files.js";
import { SandboxProcess, SandboxProcesses } from "../src/index.js";
import { Sandbox } from "../src/sandbox.js";
import { Sandboxes } from "../src/sandboxes.js";
import { json, startOrigin, type CannedResponse, type Respond } from "./helpers/origin.js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { EnvelopeSchema, Exit_Status, type Envelope } from "../src/generated/process_pb.js";

const now = "2026-07-22T12:00:00Z";
const nowDate = new Date(now);

const INACTIVE_STATUSES = ["pausing", "paused", "stopping", "stopped"];

function sandboxWire(status: string = "pending", id: string = "0198-sandbox") {
  return {
    sandbox_id: id,
    name: id === "0198-fork" ? "agent-task" : "prepared-environment",
    status,
    ...(INACTIVE_STATUSES.includes(status) ? { checkpoint: `sandbox-${id}-epoch-1` } : {}),
    vcpu_count: 2,
    mem_size_mib: 4096,
    base_image: "ubuntu:26.04",
    platform: "arm64",
    max_ttl_seconds: 3600,
    idle_ttl_seconds: 30,
    max_concurrent_execs: 8,
    endpoints: [{ port: 8080, hostname: "8080-sandbox.example.com" }],
    created_at: now,
    last_active_at: now,
  };
}

type ReplyBody = NonNullable<Parameters<typeof create<typeof EnvelopeSchema>>[1]>["body"];

const started = (processId = "0198-process"): ReplyBody => ({ case: "started", value: { processId } });
const output = (stream: "stdout" | "stderr", offset: number, data: string): ReplyBody =>
  ({ case: stream, value: { offset: BigInt(offset), data: new TextEncoder().encode(data) } });
const exited = (cursor: number): ReplyBody =>
  ({ case: "exit", value: { status: Exit_Status.COMPLETED, exitCode: 0, cursor: BigInt(cursor) } });
const failed = (code: string, message: string): ReplyBody => ({ case: "error", value: { code, message } });

function ok(data: unknown) {
  return {
    data: { success: true, data },
    response: new Response(null, { status: 200 }),
  };
}

// Local control-plane origins started by tests, closed after each one.
const origins: Array<Awaited<ReturnType<typeof startOrigin>>> = [];

async function origin(respond: Respond) {
  const started = await startOrigin(respond);
  origins.push(started);
  return started;
}

function recorded(control: Awaited<ReturnType<typeof startOrigin>>) {
  return control.requests.map(({ method, url, body }) => ({ method, path: url.pathname, body }));
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestWebSocket.autoOpen = true;
  await Promise.all(origins.splice(0).map((started) => started.close()));
});

/** A runtime speaking the binary process protocol on one WebSocket. */
class TestWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TestWebSocket[] = [];
  static autoOpen = true;

  readonly url: string;
  readonly protocol: string;
  readonly sent: Envelope[] = [];
  readyState = 0;
  binaryType = "blob";
  private readonly listeners = new Map<
    string,
    Array<{ listener: (event: any) => void; once: boolean }>
  >();

  constructor(url: string, protocol?: string) {
    this.url = url;
    this.protocol = protocol ?? "";
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

  send(data: Uint8Array) {
    const frame = fromBinary(EnvelopeSchema, data);
    this.sent.push(frame);
    // Return stdin credit as the guest would, and confirm detaches.
    if (frame.body.case === "stdin") {
      const bytes = Math.max(frame.body.value.length, 256);
      queueMicrotask(() => this.reply(frame.channelId, { case: "windowUpdate", value: { bytes } }));
    }
    if (frame.body.case === "detach")
      queueMicrotask(() => this.reply(frame.channelId, { case: "detached", value: {} }));
  }

  /** The first message the SDK sent with this body type. */
  request<C extends Envelope["body"]["case"]>(kind: C) {
    const frame = this.sent.find((frame) => frame.body.case === kind);
    assert.ok(frame, `no ${kind} message was sent`);
    return frame as Envelope & { body: Extract<Envelope["body"], { case: C }> };
  }

  reply(channelId: number, body: ReplyBody) {
    const data = toBinary(EnvelopeSchema, create(EnvelopeSchema, { channelId, body }));
    this.emit("message", { data: data.slice().buffer });
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
    imageDigest: "",
    platform: "arm64",
    maxTtlSeconds: 3600,
    idleTtlSeconds: 30,
    maxConcurrentExecs: 8,
    endpoints: [{ port: 8080, hostname: "8080-sandbox.example.com" }],
    mounts: [],
    createdAt: nowDate,
    runningAt: undefined,
    finishedAt: undefined,
    lastActiveAt: nowDate,
    exitReason: undefined,
    checkpoint: undefined,
  });

  const created = await sandboxes.create({
    name: "prepared-environment",
    vcpuCount: 8,
    memSizeMiB: 16 * 1024,
    baseImage: "ubuntu:26.04",
    env: { NODE_ENV: "test" },
    maxTtlSeconds: 600,
    idleTtlSeconds: 30,
    maxConcurrentExecs: 16,
    ports: [3000, 8080],
    network: {
      egress: {
        default: "deny",
        allow: [
          "github.com",
          "*.github.com",
          "140.82.112.0/20",
          {
            target: "api.openai.com",
            transform: { headers: { Authorization: "Bearer brokered-token" } },
          },
        ],
        deny: ["169.254.0.0/16"],
        drain_on_pause: [
          "bedrock-runtime.*.amazonaws.com",
        ],
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
          image_id: undefined,
          env: { NODE_ENV: "test" },
          max_ttl_seconds: 600,
          idle_ttl_seconds: 30,
          max_concurrent_execs: 16,
          ports: [3000, 8080],
          network: {
            egress: {
              default: "deny",
              allow: [
                "github.com",
                "*.github.com",
                "140.82.112.0/20",
                {
                  target: "api.openai.com",
                  transform: { headers: { Authorization: "Bearer brokered-token" } },
                },
              ],
              deny: ["169.254.0.0/16"],
              drain_on_pause: [
                "bedrock-runtime.*.amazonaws.com",
              ],
            },
          },
        },
      },
    },
  ]);
});

test("sandbox public ports use the expose/list/unexpose API", async () => {
  const endpoint = { port: 3000, hostname: "3000-sandbox.example.com" };
  const responses: CannedResponse[] = [
    json({ success: true, data: endpoint }, 201),
    json({ success: true, data: endpoint }),
    json({ success: true, data: { ports: [endpoint] } }),
    { status: 204 },
    json({ success: true, data: { ports: [] } }),
    json({ success: false, error: "port not found" }, 404),
  ];
  const control = await origin(() => responses.shift() ?? json({ success: false, error: "unexpected request" }, 500));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  assert.equal(await sandbox.exposePort(3000), endpoint.hostname);
  assert.equal(await sandbox.exposePort(3000), endpoint.hostname);
  assert.deepEqual(await sandbox.listPorts(), [endpoint]);
  assert.equal(await sandbox.unexposePort(3000), undefined);
  assert.deepEqual(await sandbox.listPorts(), []);
  await assert.rejects(sandbox.unexposePort(3000), (error: unknown) => error instanceof ArchilApiError && error.status === 404);
  assert.deepEqual(sandbox.endpoints, sandboxWire().endpoints);
  assert.deepEqual(recorded(control), [
    { method: "PUT", path: "/api/sandboxes/0198-sandbox/ports/3000", body: "" },
    { method: "PUT", path: "/api/sandboxes/0198-sandbox/ports/3000", body: "" },
    { method: "GET", path: "/api/sandboxes/0198-sandbox/ports", body: "" },
    { method: "DELETE", path: "/api/sandboxes/0198-sandbox/ports/3000", body: "" },
    { method: "GET", path: "/api/sandboxes/0198-sandbox/ports", body: "" },
    { method: "DELETE", path: "/api/sandboxes/0198-sandbox/ports/3000", body: "" },
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
  assert.equal("expiresAt" in sandbox, false);
  assert.equal("expiresAt" in sandbox.toJSON(), false);
  assert.equal(sandbox.createdAt.toISOString(), "2026-07-22T12:00:00.000Z");
});

test("sandbox getNetwork and updateNetwork use the active runtime policy", async () => {
  const calls: Array<{ method: string; path: string; options: any }> = [];
  const network = {
    egress: {
      default: "allow" as const,
      allow: [
        "api.github.com",
        {
          target: "api.openai.com",
          transform: { headers: { Authorization: "Bearer brokered-token" } },
        },
      ],
      deny: ["169.254.0.0/16", "*.internal.example"],
    },
  };
  const client = {
    GET: async (path: string, options: unknown) => {
      calls.push({ method: "GET", path, options });
      return ok(network);
    },
    PUT: async (path: string, options: unknown) => {
      calls.push({ method: "PUT", path, options });
      return ok(network);
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  assert.deepEqual(await sandbox.getNetwork(), network);
  assert.deepEqual(await sandbox.updateNetwork(network), network);
  assert.deepEqual(calls, [
    {
      method: "GET",
      path: "/api/sandboxes/{sid}/network",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
    {
      method: "PUT",
      path: "/api/sandboxes/{sid}/network",
      options: { params: { path: { sid: "0198-sandbox" } }, body: network },
    },
  ]);
});

test.each([undefined, 0, 30])("sandbox creation serializes idle TTL %s", async (idleTtlSeconds) => {
  const control = await origin(() => json({ success: true, data: sandboxWire("running") }));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  await new Sandboxes(client).create({ idleTtlSeconds });
  const [request] = control.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url.pathname, "/api/sandboxes");
  assert.deepEqual(JSON.parse(request.body), idleTtlSeconds === undefined ? {} : { idle_ttl_seconds: idleTtlSeconds });
});

test("sandbox creation sends imageId and exposes the image digest", async () => {
  const imageId = "a".repeat(64);
  const responses: CannedResponse[] = [
    json({ success: false, error: "image has no successful build", code: "image_not_ready" }, 409),
    json({ success: true, data: { ...sandboxWire("running"), base_image: "", image_digest: "sha256:abc" } }),
  ];
  const control = await origin(() => responses.shift() ?? json({ success: false, error: "unexpected request" }, 500));
  const sandboxes = new Sandboxes(createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url }));

  await assert.rejects(sandboxes.create({ imageId }), (error: unknown) => {
    assert.ok(error instanceof ArchilApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "image_not_ready");
    return true;
  });
  const sandbox = await sandboxes.create({ imageId });
  assert.equal(sandbox.baseImage, "");
  assert.equal(sandbox.imageDigest, "sha256:abc");
  for (const request of control.requests) {
    assert.deepEqual(JSON.parse(request.body), { image_id: imageId });
  }
});

test("sandbox snapshots from older servers default idle TTL to disabled", () => {
  const { idle_ttl_seconds: _, ...data } = sandboxWire("running");
  const sandbox = new Sandbox(data as any, {} as ApiClient);
  assert.equal(sandbox.idleTtlSeconds, 0);
  assert.equal(sandbox.toJSON().idleTtlSeconds, 0);
});

test.each([
  { input: 86_400, body: { timeout: 86400 } },
  { input: { timeoutSeconds: 86400 }, body: { timeout: 86400 } },
  { input: { idleTtlSeconds: 45 }, body: { idle_ttl_seconds: 45 } },
  { input: { idleTtlSeconds: 0 }, body: { idle_ttl_seconds: 0 } },
  { input: { timeoutSeconds: 86400, idleTtlSeconds: 45 }, body: { timeout: 86400, idle_ttl_seconds: 45 } },
])("sandbox setTimeout retries $input and refreshes its fields", async ({ input, body }) => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let attempts = 0;
  const updated = {
    ...sandboxWire("running"),
    max_ttl_seconds: body.timeout ?? 3600,
    idle_ttl_seconds: body.idle_ttl_seconds ?? 30,
  };
  const control = await origin(() => {
    attempts++;
    // Dropping the connection stands in for a transport failure.
    if (attempts === 1) return { destroy: true };
    if (attempts < 4) return json({ success: false, error: "unavailable" }, attempts === 2 ? 429 : 503);
    return json({ success: true, data: updated });
  });
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  assert.equal(await sandbox.setTimeout(input), sandbox);
  assert.equal(attempts, 4);
  for (const request of control.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url.pathname, "/api/sandboxes/0198-sandbox/timeout");
    assert.deepEqual(JSON.parse(request.body), body);
  }
  assert.equal(sandbox.maxTtlSeconds, updated.max_ttl_seconds);
  assert.equal(sandbox.idleTtlSeconds, updated.idle_ttl_seconds);
  assert.equal(sandbox.toJSON().idleTtlSeconds, updated.idle_ttl_seconds);
});

test.each([400, 409])("sandbox setTimeout surfaces %s without retrying or changing its fields", async (status) => {
  const control = await origin(() => json({ success: false, error: "invalid TTL" }, status));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const sandbox = new Sandbox(sandboxWire("running") as any, client);
  const before = sandbox.toJSON();
  await assert.rejects(sandbox.setTimeout({ idleTtlSeconds: -1 }), (error: unknown) => {
    assert.ok(error instanceof ArchilApiError);
    assert.equal(error.status, status);
    assert.equal(error.message, "invalid TTL");
    return true;
  });
  assert.equal(control.requests.length, 1);
  assert.deepEqual(sandbox.toJSON(), before);
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

test("Sandboxes sends valid mount options through the HTTP client", async () => {
  const mounts = [
    { disk_id: "dsk-0123456789abcdef", path: "/mnt/archil", read_only: false, conditional: false, queue_ms: 5000 },
    { disk_id: "dsk-fedcba9876543210", path: "/workspace", subdirectory: "repo", read_only: false, conditional: true },
    { disk_id: "dsk-0000000000000001", path: "/mnt/models", read_only: true, conditional: false },
  ];
  const control = await origin((request) => json({
    success: true,
    data: request.method === "GET"
      ? { id: "dsk-fedcba9876543210", name: "workspace", createdAt: now }
      : { ...sandboxWire("running"), mounts },
  }));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const disk = await new Disks(client, "aws-us-east-1").get("dsk-fedcba9876543210");
  const created = await new Sandboxes(client).create({
    imageId: "a".repeat(64),
    idleTtlSeconds: 30,
    ports: [8080],
    mounts: [
      { disk: "dsk-0123456789abcdef", path: "/mnt/archil", queueMs: 5000 },
      { disk, path: "/workspace", subdirectory: "repo", conditional: true },
      { disk: "dsk-0000000000000001", path: "/mnt/models", readOnly: true },
    ],
  });

  assert.deepEqual(JSON.parse(control.requests.at(-1)!.body), {
    image_id: "a".repeat(64), idle_ttl_seconds: 30, ports: [8080], mounts,
  });
  assert.deepEqual(created.mounts, [
    { diskId: "dsk-0123456789abcdef", path: "/mnt/archil", readOnly: false, conditional: false, queueMs: 5000 },
    { diskId: disk.id, path: "/workspace", subdirectory: "repo", readOnly: false, conditional: true },
    { diskId: "dsk-0000000000000001", path: "/mnt/models", readOnly: true, conditional: false },
  ]);
  assert.deepEqual(created.toJSON().mounts, created.mounts);
});

test("a sole sandbox mount can omit its path", async () => {
  const control = await origin(() => json({ success: true, data: {
    ...sandboxWire("running"),
    mounts: [{ disk_id: "dsk-0123456789abcdef", path: "/mnt/archil" }],
  } }));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const sandbox = await new Sandboxes(client).create({ mounts: [{ disk: "dsk-0123456789abcdef" }] });
  assert.deepEqual(JSON.parse(control.requests[0].body), {
    mounts: [{ disk_id: "dsk-0123456789abcdef", read_only: false, conditional: false }],
  });
  assert.equal(sandbox.mounts[0].path, "/mnt/archil");
});

test.each([undefined, []])("create preserves omitted versus empty mounts (%j)", async (mounts) => {
  const control = await origin(() => json({ success: true, data: sandboxWire("running") }));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const sandbox = await new Sandboxes(client).create({ mounts });
  assert.deepEqual(JSON.parse(control.requests[0].body), mounts === undefined ? {} : { mounts: [] });
  assert.deepEqual(sandbox.mounts, []);
});

test.each([
  { name: "retain", mounts: undefined, expectedBody: undefined },
  { name: "clear", mounts: [], expectedBody: { mounts: [] } },
  {
    name: "replace",
    mounts: [{ disk: "dsk-fedcba9876543210", path: "/mnt/other", readOnly: true }],
    expectedBody: { mounts: [{ disk_id: "dsk-fedcba9876543210", path: "/mnt/other", read_only: true, conditional: false }] },
  },
])("cold start can $name sandbox mounts", async ({ mounts, expectedBody }) => {
  const previous = [{ disk_id: "dsk-0123456789abcdef", path: "/mnt/data", read_only: false, conditional: false }];
  const next = expectedBody?.mounts ?? previous;
  const control = await origin((request) => json({ success: true, data: {
    ...sandboxWire(request.method === "GET" ? "stopped" : "running"),
    mounts: request.method === "GET" ? previous : next,
  } }));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const sandbox = await new Sandboxes(client).get("0198-sandbox");
  await sandbox.start({ mounts });
  const request = control.requests.at(-1)!;
  assert.equal(request.url.pathname, "/api/sandboxes/0198-sandbox/start");
  assert.deepEqual(request.body ? JSON.parse(request.body) : undefined, expectedBody);
  assert.deepEqual(sandbox.mounts.map((mount) => mount.diskId), next.map((mount) => mount.disk_id));
  assert.deepEqual(sandbox.toJSON().mounts, sandbox.mounts);
});

test.each([
  { name: "clear", mounts: [] },
  { name: "replace", mounts: [{ disk: "dsk-0123456789abcdef", path: "/mnt/data" }] },
])("$name mounts is not replayed after an ambiguous start failure", async ({ mounts }) => {
  for (const failure of ["disconnect", "gateway"] as const) {
    let starts = 0;
    const control = await origin(() => {
      starts++;
      if (starts > 1) return json({ success: false, error: "mounts cannot change while active" }, 409);
      return failure === "disconnect"
        ? { destroy: true }
        : json({ success: false, error: "start response lost" }, 502);
    });
    const sandbox = new Sandbox(sandboxWire("stopped") as any, createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url }));

    await assert.rejects(sandbox.start({ mounts, wait: false }), (error: unknown) => {
      if (failure === "gateway") return error instanceof ArchilApiError && error.status === 502;
      return error instanceof Error && !(error instanceof ArchilApiError);
    });
    assert.equal(starts, 1);
    assert.ok(Object.hasOwn(JSON.parse(control.requests[0].body), "mounts"));
  }
});

test.each(["disconnect", "gateway"])("start without mounts still retries a %s failure", async (failure) => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let starts = 0;
  const control = await origin(() => {
    starts++;
    if (starts === 1) return failure === "disconnect"
      ? { destroy: true }
      : json({ success: false, error: "start response lost" }, 502);
    return json({ success: true, data: sandboxWire("running") });
  });
  const sandbox = new Sandbox(sandboxWire("stopped") as any, createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url }));

  await sandbox.start({ wait: false });

  assert.equal(starts, 2);
  assert.equal(sandbox.status, "running");
  assert.ok(control.requests.every((request) => request.body === ""));
});

test.each([
  { name: "clear", mounts: [] },
  { name: "replace", mounts: [{ disk: "dsk-0123456789abcdef", path: "/mnt/data" }] },
])(
  "start to $name mounts retries connection-establishment failures",
  async ({ mounts }) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let attempts = 0;
    const client = {
      POST: async () => {
        attempts++;
        if (attempts === 1) throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
        });
        return ok(sandboxWire("running"));
      },
    } as unknown as ApiClient;
    const sandbox = new Sandbox(sandboxWire("stopped") as any, client);

    await sandbox.start({ mounts, wait: false });

    assert.equal(attempts, 2);
    assert.equal(sandbox.status, "running");
  },
);

test("create surfaces mount validation errors without retrying", async () => {
  const control = await origin(() => json({
    success: false, code: "bad_request", error: "mounts[0].path: path is required when mounting multiple disks",
  }, 400));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  await assert.rejects(new Sandboxes(client).create({ mounts: [
    { disk: "dsk-0123456789abcdef" },
    { disk: "dsk-fedcba9876543210", path: "/workspace" },
  ] }), (error: unknown) => error instanceof ArchilApiError && error.status === 400 && error.code === "bad_request");
  assert.equal(control.requests.length, 1);
});

test("rejected mount replacement leaves the sandbox snapshot intact", async () => {
  const previous = [{ disk_id: "dsk-0123456789abcdef", path: "/mnt/data", read_only: false, conditional: false }];
  const control = await origin((request) => request.method === "GET"
    ? json({ success: true, data: { ...sandboxWire("running"), mounts: previous } })
    : json({ success: false, code: "conflict", error: "mounts cannot be changed while active" }, 409));
  const client = createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url });
  const sandbox = await new Sandboxes(client).get("0198-sandbox");
  await assert.rejects(sandbox.start({ mounts: [] }),
    (error: unknown) => error instanceof ArchilApiError && error.status === 409);
  assert.equal(sandbox.status, "running");
  assert.equal(sandbox.mounts[0].diskId, previous[0].disk_id);
  assert.equal(control.requests.length, 2);
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
    GET: async () => ok(sandboxWire("stopped")),
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
      { path: "/api/sandboxes/{sid}/pause", wait: undefined },
      { path: "/api/sandboxes/{sid}/fork", wait: false },
      { path: "/api/sandboxes/{sid}/resume", wait: false },
    ],
  );
});

test("fork creates a named branch and waits for it to start", async () => {
  vi.useFakeTimers();
  let post: { path: string; options: any } | undefined;
  const client = {
    POST: async (path: string, options: unknown) => {
      if (path.endsWith("/pause")) return ok(sandboxWire("stopped"));
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
      body: { name: "agent-task", checkpoint: "sandbox-0198-sandbox-epoch-1" },
    },
  });
});

test("fork pauses a running sandbox and resumes it once the fork is accepted", async () => {
  vi.useFakeTimers();
  const calls: Array<{ method: string; path: string; sid: string; wait?: boolean }> = [];
  let sourceStatus = "running";
  const nextSourceStatus: Record<string, string> = { pausing: "paused", pending: "running" };
  const client = {
    POST: async (path: string, options: any) => {
      calls.push({ method: "POST", path, sid: options.params.path.sid, wait: options.params.query?.wait });
      if (path.endsWith("/pause")) sourceStatus = "pausing";
      if (path.endsWith("/resume")) sourceStatus = "pending";
      if (path.endsWith("/fork")) {
        assert.equal(sourceStatus, "paused");
        assert.deepEqual(options.body, { name: "agent-task", checkpoint: "sandbox-0198-sandbox-epoch-1" });
        return ok(sandboxWire("pending", "0198-fork"));
      }
      return ok(sandboxWire(sourceStatus));
    },
    GET: async (path: string, options: any) => {
      calls.push({ method: "GET", path, sid: options.params.path.sid });
      if (options.params.path.sid === "0198-fork") return ok(sandboxWire("running", "0198-fork"));
      sourceStatus = nextSourceStatus[sourceStatus] ?? sourceStatus;
      return ok(sandboxWire(sourceStatus));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const forking = sandbox.fork({ name: "agent-task" });
  await vi.advanceTimersByTimeAsync(1500);
  const fork = await forking;

  assert.equal(fork.id, "0198-fork");
  assert.equal(fork.status, "running");
  assert.equal(sandbox.status, "running");
  assert.equal(sandbox.checkpoint, undefined);
  assert.deepEqual(calls, [
    { method: "POST", path: "/api/sandboxes/{sid}/pause", sid: "0198-sandbox", wait: undefined },
    { method: "GET", path: "/api/sandboxes/{sid}", sid: "0198-sandbox" },
    { method: "POST", path: "/api/sandboxes/{sid}/fork", sid: "0198-sandbox", wait: false },
    { method: "POST", path: "/api/sandboxes/{sid}/resume", sid: "0198-sandbox", wait: false },
    { method: "GET", path: "/api/sandboxes/{sid}", sid: "0198-fork" },
    { method: "GET", path: "/api/sandboxes/{sid}", sid: "0198-sandbox" },
  ]);
});

test("fork keeps the pause checkpoint when someone else resumes the source first", async () => {
  vi.useFakeTimers();
  const forkBodies: unknown[] = [];
  let polls = 0;
  const client = {
    POST: async (path: string, options: any) => {
      if (path.endsWith("/pause")) return ok(sandboxWire("pausing"));
      if (path.endsWith("/fork")) {
        forkBodies.push(options.body);
        return ok(sandboxWire("running", "0198-fork"));
      }
      return ok(sandboxWire("running"));
    },
    GET: async (_path: string, options: any) => {
      if (options.params.path.sid === "0198-fork") return ok(sandboxWire("running", "0198-fork"));
      polls += 1;
      // The first poll already sees the source running again at a later
      // epoch, with no checkpoint of its own.
      return ok(sandboxWire("running"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const forking = sandbox.fork();
  await vi.advanceTimersByTimeAsync(1000);
  const fork = await forking;

  assert.equal(fork.id, "0198-fork");
  assert.equal(polls, 1);
  assert.deepEqual(forkBodies, [{ name: undefined, checkpoint: "sandbox-0198-sandbox-epoch-1" }]);
});

test("fork returns the child even when the source cannot be resumed", async () => {
  vi.useFakeTimers();
  const posts: string[] = [];
  const client = {
    POST: async (path: string) => {
      posts.push(path);
      if (path.endsWith("/pause")) return ok(sandboxWire("pausing"));
      if (path.endsWith("/fork")) return ok(sandboxWire("running", "0198-fork"));
      return {
        data: { success: false, error: "no runtime host available" },
        response: new Response(null, { status: 409 }),
      };
    },
    GET: async () => ok(sandboxWire("paused")),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const forking = sandbox.fork();
  await vi.advanceTimersByTimeAsync(1000);
  const fork = await forking;

  assert.equal(fork.id, "0198-fork");
  assert.equal(sandbox.status, "paused");
  assert.deepEqual(posts, [
    "/api/sandboxes/{sid}/pause",
    "/api/sandboxes/{sid}/fork",
    "/api/sandboxes/{sid}/resume",
  ]);
});

test("fork resumes the source even when waiting for the pause fails", async () => {
  vi.useFakeTimers();
  const posts: string[] = [];
  const client = {
    POST: async (path: string) => {
      posts.push(path);
      if (path.endsWith("/pause")) return ok(sandboxWire("pausing"));
      return ok(sandboxWire("pending"));
    },
    GET: async () => ({
      data: { success: false, error: "sandbox lookup failed" },
      response: new Response(null, { status: 400 }),
    }),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const forking = sandbox.fork();
  const rejection = assert.rejects(forking, /sandbox lookup failed/);
  await vi.advanceTimersByTimeAsync(1000);
  await rejection;

  assert.deepEqual(posts, ["/api/sandboxes/{sid}/pause", "/api/sandboxes/{sid}/resume"]);
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

test.each([undefined, "/workspace/a 'quote' $literal"])("exec forwards cwd=%s and waits for its result", async (cwd) => {
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
    cwd,
    env: { HELLO: "world" },
    timeoutSeconds: 10,
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const start = socket.request("start");
  socket.reply(start.channelId, started());
  socket.reply(start.channelId, output("stdout", 0, "hello"));
  socket.reply(start.channelId, exited(5));

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
  const { command, cwd: sentCwd, env, timeoutSeconds } = start.body.value;
  assert.deepEqual(
    { command, cwd: sentCwd, env, timeoutSeconds },
    { command: "printf hello", cwd, env: { HELLO: "world" }, timeoutSeconds: 10n },
  );
});

test("process connections retry API and WebSocket handshake failures", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let connectionAttempts = 0;
  const client = {
    POST: async () => {
      connectionAttempts++;
      if (connectionAttempts === 1) throw new TypeError("fetch failed");
      if (connectionAttempts === 2) {
        return {
          error: { error: "temporarily unavailable" },
          response: new Response(null, { status: 503 }),
        };
      }
      return ok({
        url: `wss://sandbox.example/connect?token=${connectionAttempts}`,
        expires_at: now,
      });
    },
  } as unknown as ApiClient;
  vi.stubGlobal("WebSocket", TestWebSocket);
  TestWebSocket.instances = [];
  TestWebSocket.autoOpen = false;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const starting = sandbox.run("true");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances.length, 1));
  assert.equal(connectionAttempts, 3);
  const first = TestWebSocket.instances[0];
  first.emit("error", {});

  await vi.waitFor(() => assert.equal(TestWebSocket.instances.length, 2));
  const second = TestWebSocket.instances[1];
  assert.equal(connectionAttempts, 4);
  assert.equal(first.sent.length, 0);
  second.emit("open", {});
  await vi.waitFor(() => assert.equal(second.sent.length, 1));
  const start = second.request("start");
  second.reply(start.channelId, started());

  const process = await starting;
  assert.equal(start.body.value.command, "true");
  assert.deepEqual(start.body.value.env, {});
  await process.disconnect();
});

test.each(["sandbox", "processes"] as const)("%s API returns a process before exit and supports reattachment", async (api) => {
  const calls: Array<{ path: string; options: any }> = [];
  const collected: Array<{ stream: string; offset: number; data: number[] }> = [];
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

  assert.ok(sandbox.processes instanceof SandboxProcesses);
  const start = api === "processes"
    ? sandbox.processes.start.bind(sandbox.processes)
    : sandbox.run.bind(sandbox);
  const attach = api === "processes"
    ? sandbox.processes.connect.bind(sandbox.processes)
    : sandbox.attach.bind(sandbox);
  const starting = start("echo hello", {
    cwd: "/workspace/app",
    terminal: false,
    env: { HELLO: "world" },
    timeoutSeconds: 10,
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const request = socket.request("start");
  socket.reply(request.channelId, started());
  const process = await starting;
  void collectStream(process, (event) =>
      collected.push({
        stream: event.stream,
        offset: event.offset,
        data: Array.from(event.data),
      })).catch(() => {});

  assert.ok(process instanceof SandboxProcess);
  assert.equal(process.id, "0198-process");
  assert.equal(process.cursor, 0);
  assert.equal(process.connected, true);
  assert.equal(socket.url, "wss://sandbox.example/connect?token=signed");
  const { command, cwd, terminal, env, timeoutSeconds } = request.body.value;
  assert.deepEqual(
    { command, cwd, terminal, env, timeoutSeconds },
    { command: "echo hello", cwd: "/workspace/app", terminal: undefined, env: { HELLO: "world" }, timeoutSeconds: 10n },
  );

  socket.reply(request.channelId, output("stdout", 0, "hello\n"));
  await vi.waitFor(() => assert.equal(process.cursor, 6));
  await process.sendInput("more\n");
  await process.closeStdin();
  assert.equal(new TextDecoder().decode(socket.request("stdin").body.value), "more\n");
  assert.equal(socket.request("closeStdin").channelId, request.channelId);
  await process.disconnect();
  assert.equal(process.connected, false);
  assert.equal(socket.request("detach").channelId, request.channelId);

  const connecting = attach(process.id, {
    offset: process.cursor,
  });
  await vi.waitFor(() => socket.request("attach"));
  const reattach = socket.request("attach");
  assert.notEqual(reattach.channelId, request.channelId);
  assert.deepEqual(
    { processId: reattach.body.value.processId, offset: reattach.body.value.offset },
    { processId: "0198-process", offset: 6n },
  );
  socket.reply(reattach.channelId, { case: "attached", value: { processId: "0198-process" } });
  const resumedProcess = await connecting;
  void collectStream(resumedProcess, (event) =>
      collected.push({
        stream: event.stream,
        offset: event.offset,
        data: Array.from(event.data),
      })).catch(() => {});
  const waiting = resumedProcess.wait();
  socket.reply(reattach.channelId, output("stderr", 6, "warning\n"));
  socket.reply(reattach.channelId, exited(14));

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
  await vi.waitFor(() => assert.equal(collected.length, 2));
  assert.deepEqual(collected, [
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
  // Reattachment reuses the sandbox's open process connection.
  assert.equal(TestWebSocket.instances.length, 1);
  assert.deepEqual(calls, [
    {
      path: "/api/sandboxes/{sid}/connections",
      options: { params: { path: { sid: "0198-sandbox" } } },
    },
  ]);
});

test("process iterators report a replay gap after retention expires", async () => {
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

  const connecting = sandbox.attach("0198-process", {
    offset: 1_000,
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const request = socket.request("attach");
  assert.deepEqual(
    { processId: request.body.value.processId, offset: request.body.value.offset },
    { processId: "0198-process", offset: 1_000n },
  );
  socket.reply(request.channelId, { case: "attached", value: { processId: "0198-process" } });
  const process = await connecting;
  const waiting = process.wait();

  socket.reply(request.channelId, output("stdout", 1024, "retained\n"));
  socket.reply(request.channelId, exited(1033));

  await assert.rejects(waiting, /output gap/);
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

  const starting = sandbox.run("codex", {
    terminal: { cols: 132, rows: 43 },
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const request = socket.request("start");
  socket.reply(request.channelId, started());
  const process = await starting;

  assert.equal(request.body.value.command, "codex");
  assert.deepEqual(
    { rows: request.body.value.terminal?.rows, cols: request.body.value.terminal?.cols },
    { rows: 43, cols: 132 },
  );
  assert.deepEqual(request.body.value.env, {});

  await process.sendInput("Review this repository\n");
  await process.sendInput(new Uint8Array([3]));
  const stdin = socket.sent.filter((frame) => frame.body.case === "stdin")
    .map((frame) => frame.body.value as Uint8Array);
  assert.equal(new TextDecoder().decode(stdin[0]), "Review this repository\n");
  assert.deepEqual(stdin[1], new Uint8Array([3]));

  // Resize and kill are channels of their own on the same connection.
  const resizing = process.resize({ cols: 160, rows: 50 });
  await vi.waitFor(() => socket.request("resize"));
  const resize = socket.request("resize");
  assert.deepEqual(
    { processId: resize.body.value.processId, rows: resize.body.value.terminal?.rows, cols: resize.body.value.terminal?.cols },
    { processId: "0198-process", rows: 50, cols: 160 },
  );
  socket.reply(resize.channelId, { case: "resized", value: {} });
  await resizing;
  const killing = process.kill();
  await vi.waitFor(() => socket.request("kill"));
  const kill = socket.request("kill");
  assert.equal(kill.body.value.processId, "0198-process");
  socket.reply(kill.channelId, { case: "killed", value: {} });
  assert.equal(await killing, undefined);
  assert.equal(TestWebSocket.instances.length, 1);
  await process.disconnect();
});

test("process input is streamed as ordered protocol messages", async () => {
  const collected: Array<{ stream: string; offset: number; data: string }> = [];
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

  const starting = sandbox.run("cat", {
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const request = socket.request("start");
  socket.reply(request.channelId, started());
  const process = await starting;
  void collectStream(process, (event) =>
      collected.push({
        stream: event.stream,
        offset: event.offset,
        data: new TextDecoder().decode(event.data),
      })).catch(() => {});
  const input = new Uint8Array(2 * 1024 * 1024 + 3);
  input.fill(7);

  await process.sendInput(input);
  socket.reply(request.channelId, output("stdout", 0, "output\n"));
  await vi.waitFor(() => assert.equal(process.cursor, 7));
  assert.equal(process.cursor, 7);
  await vi.waitFor(() => assert.equal(collected.length, 1));
  assert.deepEqual(collected, [{ stream: "stdout", offset: 0, data: "output\n" }]);

  const chunks = socket.sent.filter((frame) => frame.body.case === "stdin")
    .map((frame) => (frame.body.value as Uint8Array).byteLength);
  assert.deepEqual(chunks, [...Array(32).fill(64 * 1024), 3]);
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

  const starting = sandbox.run("cat");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.reply(socket.request("start").channelId, started());
  const process = await starting;

  const send = socket.send.bind(socket);
  socket.send = () => {
    throw new Error("send failed");
  };
  await assert.rejects(process.closeStdin(), /send failed/);

  socket.send = send;
  await process.closeStdin();
  assert.equal(socket.sent[1].body.case, "closeStdin");
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

  const starting = sandbox.run("cat");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const request = socket.request("start");
  socket.reply(request.channelId, started());
  const process = await starting;

  await process.sendInput("input");
  socket.reply(request.channelId, exited(0));

  assert.equal((await process.wait()).status, "completed");
  await assert.rejects(process.sendInput("later"), /stdin is closed/);
});

test("output iterators surface runtime connection errors", async () => {
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

  const starting = sandbox.run("echo hello");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const request = socket.request("start");
  socket.reply(request.channelId, started());
  const process = await starting;
  const iterator = process.output[Symbol.asyncIterator]();

  socket.reply(request.channelId, output("stdout", 0, "hello\n"));
  assert.equal(new TextDecoder().decode((await iterator.next()).value?.data), "hello\n");
  assert.equal(process.connected, true);

  const waiting = process.wait();
  socket.reply(request.channelId, failed("process_failed", "specific runtime failure"));
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
  const collected: string[] = [];

  const starting = sandbox.run("echo hello", {
    collectOutput: false,
  });
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  const request = socket.request("start");
  socket.reply(request.channelId, started());
  const process = await starting;
  const streaming = collectStream(process, ({ data }) => collected.push(new TextDecoder().decode(data)));

  socket.reply(request.channelId, output("stdout", 0, "hello\n"));
  socket.reply(request.channelId, exited(6));

  await streaming;
  assert.deepEqual(collected, ["hello\n"]);
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

  const starting = sandbox.run("");
  await vi.waitFor(() => assert.equal(TestWebSocket.instances[0].sent.length, 1));
  const socket = TestWebSocket.instances[0];
  socket.reply(socket.request("start").channelId, failed("invalid_request", "command is required"));

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

test.each(["created", "metadata", "id"])("port token lifecycle: delete by %s", async (input) => {
  const metadata = {
    id: "token-1",
    port: 8080,
    created_at: now,
    expires_at: "2026-07-22T13:00:00Z",
  };
  const responses: CannedResponse[] = [
    json(
      {
        success: true,
        data: {
          ...metadata,
          hostname: "8080-sandbox.example.com",
          token: "secret",
        },
      },
      201,
    ),
    json({ success: true, data: metadata }),
    { status: 204 },
    json({ success: false, error: "port token not found" }, 404),
    json({ success: false, error: "backend unavailable" }, 503),
  ];
  const control = await origin(() => responses.shift() ?? json({ success: false, error: "unexpected request" }, 500));
  const client = createApiClient({
    apiKey: "test",
    region: "aws-us-east-1",
    baseUrl: control.url,
  });
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const created = await sandbox.createPortToken(8080, { ttl: "1h" });
  assert.equal(created.token, "secret");
  assert.equal(created.hostname, "8080-sandbox.example.com");

  const token = await sandbox.getPortToken(created.id);
  assert.deepEqual(token, {
    id: created.id,
    port: 8080,
    createdAt: nowDate,
    expiresAt: new Date(metadata.expires_at),
  });
  assert.deepEqual(created, {
    ...token,
    hostname: created.hostname,
    token: "secret",
  });

  const deleteTarget = input === "created" ? created : input === "metadata" ? token : created.id;
  await sandbox.deletePortToken(deleteTarget);
  await assert.rejects(
    sandbox.getPortToken(created.id),
    (error: unknown) => error instanceof ArchilApiError && error.status === 404,
  );

  // A response error must not replay creation: its one-time secret may already have been issued.
  await assert.rejects(
    sandbox.createPortToken(8080),
    (error: unknown) => error instanceof ArchilApiError && error.status === 503,
  );
  assert.deepEqual(recorded(control), [
    {
      method: "POST",
      path: "/api/sandboxes/0198-sandbox/port-tokens",
      body: '{"port":8080,"ttl":"1h"}',
    },
    {
      method: "GET",
      path: "/api/sandboxes/0198-sandbox/port-tokens/token-1",
      body: "",
    },
    {
      method: "DELETE",
      path: "/api/sandboxes/0198-sandbox/port-tokens/token-1",
      body: "",
    },
    {
      method: "GET",
      path: "/api/sandboxes/0198-sandbox/port-tokens/token-1",
      body: "",
    },
    {
      method: "POST",
      path: "/api/sandboxes/0198-sandbox/port-tokens",
      body: '{"port":8080}',
    },
  ]);
});

test("sandbox token listing follows cursors and caps the total returned", async () => {
  const tokens = [1, 2].map((id) => ({
    id: `token-${id}`,
    port: 8080,
    created_at: now,
  }));
  const queries: Array<Record<string, string>> = [];
  const control = await origin((request) => {
    const query = Object.fromEntries(request.url.searchParams);
    queries.push(query);
    return json({
      success: true,
      data: { tokens: [query.cursor ? tokens[1] : tokens[0]] },
      ...(query.cursor ? {} : { nextCursor: "token-1" }),
    });
  });
  const client = createApiClient({
    apiKey: "test",
    region: "aws-us-east-1",
    baseUrl: control.url,
  });
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const listed = await sandbox.listPortTokens();
  assert.deepEqual(listed.map((token) => token.id), ["token-1", "token-2"]);
  assert.equal(listed[0].expiresAt, undefined);
  assert.ok(listed[0].createdAt instanceof Date);
  assert.deepEqual(
    (await sandbox.listPortTokens({ limit: 1 })).map((token) => token.id),
    ["token-1"],
  );

  const page = await sandbox.listPortTokensPage({ limit: 1 });
  assert.equal(page.nextCursor, "token-1");
  assert.equal(
    (await sandbox.listPortTokensPage({ cursor: page.nextCursor })).nextCursor,
    undefined,
  );
  assert.deepEqual(queries, [
    { limit: "100" },
    { limit: "100", cursor: "token-1" },
    { limit: "1" },
    { limit: "1" },
    { limit: "100", cursor: "token-1" },
  ]);
});

test("pause reports a snapshot failure with the failed sandbox", async () => {
  const client = {
    POST: async () => ok({ ...sandboxWire("failed"), exit_reason: "snapshot failed: snapshot upload timed out" }),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);
  await assert.rejects(sandbox.pause(), (error: unknown) => {
    assert.ok(error instanceof SandboxPauseError);
    assert.equal(error.latest.status, "failed");
    assert.match(error.message, /snapshot upload timed out/);
    return true;
  });
});

async function collectStream(process: SandboxProcess, consume: (output: import("../src/sandbox-process.js").SandboxProcessOutput) => unknown): Promise<void> {
  for await (const output of process.output) consume(output);
}
