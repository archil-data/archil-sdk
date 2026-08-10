import assert from "node:assert/strict";
import { test } from "vitest";
import type { ApiClient } from "../src/client.js";
import { Sandbox, SandboxExec } from "../src/sandbox.js";
import { Sandboxes } from "../src/sandboxes.js";

const now = "2026-07-22T12:00:00Z";
const nowDate = new Date(now);

function sandboxWire(status: string = "pending") {
  return {
    sandbox_id: "0198-sandbox",
    status,
    vcpu_count: 2,
    mem_size_mib: 4096,
    max_ttl_seconds: 3600,
    max_concurrent_execs: 8,
    endpoints: [{ port: 8080, hostname: "8080-sandbox.example.com" }],
    created_at: now,
    last_active_at: now,
  };
}

function execWire(status: string = "running") {
  return {
    sandbox_id: "0198-sandbox",
    exec_id: "0198-exec",
    command: "echo hello",
    status,
    started_at: now,
    ...(status === "running"
      ? {}
      : { exit_code: 0, stdout: "hello\n", stderr: "", finished_at: now }),
  };
}

function ok(data: unknown) {
  return {
    data: { success: true, data },
    response: new Response(null, { status: 200 }),
  };
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
  assert.deepEqual(listed[0].toJSON(), {
    id: "0198-sandbox",
    status: "running",
    vcpuCount: 2,
    memSizeMiB: 4096,
    maxTtlSeconds: 3600,
    maxConcurrentExecs: 8,
    endpoints: [{ port: 8080, hostname: "8080-sandbox.example.com" }],
    createdAt: nowDate,
    runningAt: undefined,
    finishedAt: undefined,
    lastActiveAt: nowDate,
    expiresAt: undefined,
    exitReason: undefined,
  });

  const created = await sandboxes.create({
    vcpuCount: 8,
    memSizeMiB: 16 * 1024,
    baseImage: "ubuntu:26.04",
    env: { NODE_ENV: "test" },
    maxTtlSeconds: 600,
    maxConcurrentExecs: 16,
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
          vcpu_count: 8,
          mem_size_mib: 16384,
          base_image: "ubuntu:26.04",
          env: { NODE_ENV: "test" },
          max_ttl_seconds: 600,
          max_concurrent_execs: 16,
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

test("sandbox lifecycle methods return the server response without polling", async () => {
  const calls: Array<{ path: string; options: any }> = [];
  const client = {
    POST: async (path: string, options: unknown) => {
      calls.push({ path, options });
      if (path.endsWith("/stop")) return ok(sandboxWire("stopping"));
      if (path.endsWith("/pause")) return ok(sandboxWire("pausing"));
      return ok(sandboxWire("pending"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  assert.equal((await sandbox.start()).status, "pending");
  assert.equal((await sandbox.stop()).status, "stopping");
  assert.equal((await sandbox.pause()).status, "pausing");
  assert.equal((await sandbox.resume()).status, "pending");
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

test("create, start, and resume can opt out of server-side waiting", async () => {
  const calls: Array<{ path: string; options: any }> = [];
  const client = {
    POST: async (path: string, options: unknown) => {
      calls.push({ path, options });
      return ok(sandboxWire("pending"));
    },
  } as unknown as ApiClient;

  const created = await new Sandboxes(client).create({}, { wait: false });
  await created.start({ wait: false });
  await created.resume({ wait: false });

  assert.deepEqual(
    calls.map(({ path, options }) => ({ path, wait: options.params.query.wait })),
    [
      { path: "/api/sandboxes", wait: false },
      { path: "/api/sandboxes/{sid}/start", wait: false },
      { path: "/api/sandboxes/{sid}/resume", wait: false },
    ],
  );
});

test("exec translates options", async () => {
  let captured: any;
  const client = {
    POST: async (path: string, options: unknown) => {
      captured = { path, options };
      return ok(execWire("completed"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const result = await sandbox.exec("echo hello", {
    commandTty: true,
    env: { HELLO: "world" },
    timeoutSeconds: 10,
  });
  assert.ok(result instanceof SandboxExec);
  assert.equal(result.status, "completed");
  assert.deepEqual(captured, {
    path: "/api/sandboxes/{sid}/execs",
    options: {
      params: {
        path: { sid: "0198-sandbox" },
        query: { wait: true },
      },
      body: {
        command: "echo hello",
        command_tty: true,
        env: { HELLO: "world" },
        timeout_seconds: 10,
      },
    },
  });
});

test("sandbox exec objects refresh and cancel themselves", async () => {
  const calls: Array<{ method: string; path: string; options: any }> = [];
  const client = {
    GET: async (path: string, options: unknown) => {
      calls.push({ method: "GET", path, options });
      return ok(execWire("completed"));
    },
    POST: async (path: string, options: unknown) => {
      calls.push({ method: "POST", path, options });
      return ok(execWire("cancelled"));
    },
  } as unknown as ApiClient;
  const execution = new SandboxExec(execWire() as any, client);

  const refreshed = await execution.refresh();
  assert.equal(refreshed, execution); // mutates and returns the same object
  assert.equal(execution.status, "completed");

  const cancelled = await execution.cancel();
  assert.equal(cancelled, execution); // mutates and returns the same object
  assert.equal(execution.status, "cancelled");
  assert.deepEqual(calls, [
    {
      method: "GET",
      path: "/api/sandboxes/{sid}/execs/{eid}",
      options: { params: { path: { sid: "0198-sandbox", eid: "0198-exec" } } },
    },
    {
      method: "POST",
      path: "/api/sandboxes/{sid}/execs/{eid}/cancel",
      options: { params: { path: { sid: "0198-sandbox", eid: "0198-exec" } } },
    },
  ]);
  assert.deepEqual(cancelled.toJSON(), {
    sandboxId: "0198-sandbox",
    id: "0198-exec",
    command: "echo hello",
    status: "cancelled",
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
    exitReason: undefined,
    executeTimeMs: undefined,
    startedAt: nowDate,
    finishedAt: nowDate,
  });
});

test("exec can return immediately without polling", async () => {
  let postOptions: any;
  const client = {
    POST: async (_path: string, options: unknown) => {
      postOptions = options;
      return ok(execWire());
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const result = await sandbox.exec("echo hello", { wait: false });
  assert.equal(result.status, "running");
  assert.deepEqual(postOptions.params.query, { wait: false });
});

test("sandbox instance methods use the owning sandbox id", async () => {
  const calls: Array<{ method: string; path: string; options: any }> = [];
  const client = {
    GET: async (path: string, options: unknown) => {
      calls.push({ method: "GET", path, options });
      if (path.endsWith("/execs")) return ok({ execs: null });
      if (path.includes("{eid}")) return ok(execWire("completed"));
      return ok(sandboxWire("running"));
    },
    POST: async (path: string, options: unknown) => {
      calls.push({ method: "POST", path, options });
      if (path.endsWith("/stop")) return ok(sandboxWire("stopped"));
      return ok(execWire("cancelled"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  assert.equal((await sandbox.refresh()).status, "running");
  assert.equal((await sandbox.stop()).status, "stopped");
  assert.deepEqual(await sandbox.listExecs(), []);
  assert.equal((await sandbox.getExec("0198-exec")).status, "completed");
  assert.equal((await sandbox.cancelExec("0198-exec")).status, "cancelled");

  for (const call of calls) {
    assert.equal(call.options.params.path.sid, "0198-sandbox");
  }
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/api/sandboxes/{sid}/execs/{eid}/cancel",
    options: { params: { path: { sid: "0198-sandbox", eid: "0198-exec" } } },
  });
});
