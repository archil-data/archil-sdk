import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ApiClient } from "../src/client.js";
import {
  Sandbox,
  SandboxExec,
  SandboxStartError,
  SandboxWaitTimeoutError,
} from "../src/sandbox.js";
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

afterEach(() => {
  vi.useRealTimers();
});

test("Sandboxes translates list/create inputs and wraps camelCase snapshots", async () => {
  const calls: Array<{ method: string; path: string; options: any }> = [];
  const client = {
    GET: async (path: string, options: unknown) => {
      calls.push({ method: "GET", path, options });
      return ok({ sandboxes: [sandboxWire("running")] });
    },
    POST: async (path: string, options: unknown) => {
      calls.push({ method: "POST", path, options });
      return ok(sandboxWire());
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

  const created = await sandboxes.create(
    {
      vcpuCount: 4,
      memSizeMiB: 8192,
      baseImage: "ubuntu:26.04",
      env: { NODE_ENV: "test" },
      maxTtlSeconds: 600,
      maxConcurrentExecs: 16,
    },
    { waitForStart: false },
  );
  assert.equal(created.status, "pending");
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
        params: { query: { wait: false } },
        body: {
          vcpu_count: 4,
          mem_size_mib: 8192,
          kernel: undefined,
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

test("create polls pending sandboxes until they are running", async () => {
  vi.useFakeTimers();
  let gets = 0;
  const client = {
    POST: async () => ok(sandboxWire()),
    GET: async () => {
      gets++;
      return ok(sandboxWire("running"));
    },
  } as unknown as ApiClient;

  const resultPromise = new Sandboxes(client).create();
  await vi.advanceTimersByTimeAsync(500);
  const result = await resultPromise;
  assert.equal(result.status, "running");
  assert.equal(gets, 1);
});

test("failed create carries the created sandbox", async () => {
  const client = {
    POST: async () => ok({ ...sandboxWire("failed"), exit_reason: "boot failed" }),
  } as unknown as ApiClient;

  await assert.rejects(
    new Sandboxes(client).create(),
    (error: unknown) => {
      assert.ok(error instanceof SandboxStartError);
      assert.equal(error.latest.id, "0198-sandbox");
      assert.equal(error.latest.status, "failed");
      assert.equal(error.latest.exitReason, "boot failed");
      return true;
    },
  );
});

test("start throws a timeout carrying the latest sandbox snapshot", async () => {
  const client = {
    POST: async () => ok(sandboxWire()),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire() as any, client);

  await assert.rejects(
    sandbox.start({ waitUpToMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof SandboxWaitTimeoutError);
      assert.equal(error.operation, "start");
      assert.equal(error.timeoutMs, 0);
      assert.ok(error.latest instanceof Sandbox);
      assert.equal(error.latest.status, "pending");
      return true;
    },
  );
});

test("start fails immediately when startup enters an inactive state", async () => {
  const client = {
    POST: async () => ok({ ...sandboxWire("failed"), exit_reason: "boot failed" }),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire() as any, client);

  await assert.rejects(
    sandbox.start(),
    (error: any) => {
      assert.equal(error.code, "SANDBOX_START_FAILED");
      assert.match(error.message, /boot failed/);
      return true;
    },
  );
});

test("stop polls stopping sandboxes until they are stopped", async () => {
  vi.useFakeTimers();
  let gets = 0;
  const client = {
    POST: async () => ok(sandboxWire("stopping")),
    GET: async () => {
      gets++;
      return ok(sandboxWire("stopped"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const resultPromise = sandbox.stop();
  await vi.advanceTimersByTimeAsync(500);
  const result = await resultPromise;
  assert.equal(result, sandbox); // mutates and returns the same object
  assert.equal(sandbox.status, "stopped");
  assert.equal(gets, 1);
});

test("stop can return immediately without polling", async () => {
  let gets = 0;
  const client = {
    POST: async () => ok(sandboxWire("stopping")),
    GET: async () => {
      gets++;
      return ok(sandboxWire("stopped"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const result = await sandbox.stop({ waitForStop: false });
  assert.equal(result.status, "stopping");
  assert.equal(gets, 0);
});

test("stop timeout carries the latest stopping sandbox", async () => {
  const client = {
    POST: async () => ok(sandboxWire("stopping")),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  await assert.rejects(
    sandbox.stop({ waitUpToMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof SandboxWaitTimeoutError);
      assert.equal(error.operation, "stop");
      assert.equal(error.timeoutMs, 0);
      assert.ok(error.latest instanceof Sandbox);
      assert.equal(error.latest.status, "stopping");
      return true;
    },
  );
});

test("exec translates options and can return immediately", async () => {
  let captured: any;
  const client = {
    POST: async (path: string, options: unknown) => {
      captured = { path, options };
      return ok(execWire());
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const result = await sandbox.exec("echo hello", {
    commandTty: true,
    env: { HELLO: "world" },
    timeoutSeconds: 10,
    waitForCompletion: false,
  });
  assert.ok(result instanceof SandboxExec);
  assert.equal(result.status, "running");
  assert.deepEqual(captured, {
    path: "/api/sandboxes/{sid}/execs",
    options: {
      params: {
        path: { sid: "0198-sandbox" },
        query: { wait: false },
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

test("exec polls to a terminal result", async () => {
  vi.useFakeTimers();
  let gets = 0;
  const client = {
    POST: async () => ok(execWire()),
    GET: async () => {
      gets++;
      return ok(execWire("completed"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  const resultPromise = sandbox.exec("echo hello");
  await vi.advanceTimersByTimeAsync(500);
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "hello\n");
  assert.equal(gets, 1);
});

test("exec timeout carries the latest running exec", async () => {
  const client = {
    POST: async () => ok(execWire()),
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  await assert.rejects(
    sandbox.exec("echo hello", { waitUpToMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof SandboxWaitTimeoutError);
      assert.equal(error.operation, "exec");
      assert.equal(error.latest.status, "running");
      return true;
    },
  );
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
      if (path.endsWith("/stop")) return ok(sandboxWire("stopping"));
      return ok(execWire("cancelled"));
    },
  } as unknown as ApiClient;
  const sandbox = new Sandbox(sandboxWire("running") as any, client);

  assert.equal((await sandbox.refresh()).status, "running");
  assert.equal((await sandbox.stop({ waitForStop: false })).status, "stopping");
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
