import assert from "node:assert/strict";
import { test } from "vitest";
import { Archil, ArchilApiError, ArchilError, ArchilTimeoutError } from "../src/index.js";

interface Call {
  method: string;
  path: string;
  search: string;
  body?: unknown;
}

type Responder = (call: Call) => { status?: number; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(data: unknown, status = 200): { status: number; body: unknown } {
  return { status, body: { success: true, data } };
}

function sandboxWire(overrides: Record<string, unknown> = {}) {
  return {
    sandbox_id: "sb-1",
    status: "running",
    vcpu_count: 2,
    mem_size_mib: 4096,
    max_ttl_seconds: 3600,
    max_concurrent_execs: 32,
    created_at: "2026-07-14T00:00:00Z",
    last_active_at: "2026-07-14T00:00:00Z",
    ...overrides,
  };
}

async function withStub<T>(respond: Responder, fn: (archil: Archil, calls: Call[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const call: Call = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      body: req.method === "POST" ? JSON.parse((await req.text()) || "{}") : undefined,
    };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return json(body, status);
  };
  try {
    const archil = new Archil({
      apiKey: "key-test",
      region: "aws-us-east-1",
      baseUrl: "http://cp.test",
      s3BaseUrl: "http://s3.test",
    });
    return await fn(archil, calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const fastPoll = { pollIntervalMs: 1 };

test("create maps options to the wire request and waits until running", async () => {
  let polls = 0;
  await withStub(
    (call) => {
      if (call.method === "POST") return envelope(sandboxWire({ status: "pending" }), 202);
      polls += 1;
      return envelope(sandboxWire({ status: polls < 2 ? "pending" : "running" }));
    },
    async (archil, calls) => {
      const sandbox = await archil.sandbox.create({
        image: "ubuntu-22.04",
        disks: [{ disk: "dsk-1", path: "data", readOnly: true }],
        ports: [{ port: 8080 }],
        resources: { vcpus: 2, memoryMiB: 4096 },
        env: { FOO: "bar" },
        ttlMs: 3_600_000,
        ...fastPoll,
      });
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].path, "/api/sandboxes");
      assert.deepEqual(calls[0].body, {
        base_image: "ubuntu-22.04",
        archil_mounts: [{ disk_id: "dsk-1", relative_path: "data", read_only: true }],
        port_mappings: [{ container_port: 8080, protocol: "tcp" }],
        vcpu_count: 2,
        mem_size_mib: 4096,
        env: { FOO: "bar" },
        max_ttl_seconds: 3600,
      });
      assert.equal(sandbox.id, "sb-1");
      assert.equal(sandbox.status, "running");
      assert.equal(polls, 2);
    },
  );
});

test("create sends an empty body by default", async () => {
  await withStub(
    () => envelope(sandboxWire(), 202),
    async (archil, calls) => {
      await archil.sandbox.create();
      assert.deepEqual(calls[0].body, {});
    },
  );
});

test("create fails fast when the sandbox dies while waiting", async () => {
  await withStub(
    (call) =>
      call.method === "POST"
        ? envelope(sandboxWire({ status: "pending" }), 202)
        : envelope(sandboxWire({ status: "failed", exit_reason: "no capacity" })),
    async (archil) => {
      await assert.rejects(
        archil.sandbox.create(fastPoll),
        (err: unknown) => err instanceof ArchilError && /failed: no capacity/.test(err.message),
      );
    },
  );
});

test("create times out while waiting", async () => {
  await withStub(
    (call) => envelope(sandboxWire({ status: "pending" }), call.method === "POST" ? 202 : 200),
    async (archil) => {
      await assert.rejects(
        archil.sandbox.create({ waitTimeoutMs: 5, ...fastPoll }),
        ArchilTimeoutError,
      );
    },
  );
});

test("run submits the exec and polls until terminal", async () => {
  let polls = 0;
  await withStub(
    (call) => {
      if (call.path === "/api/sandboxes/sb-1") return envelope(sandboxWire());
      if (call.method === "POST") {
        return envelope(
          {
            sandbox_id: "sb-1",
            exec_id: "ex-1",
            command: "ls",
            status: "running",
            started_at: "2026-07-14T00:00:00Z",
          },
          202,
        );
      }
      polls += 1;
      return envelope({
        sandbox_id: "sb-1",
        exec_id: "ex-1",
        command: "ls",
        status: polls < 2 ? "running" : "completed",
        exit_code: 0,
        stdout: "file\n",
        stderr: "",
        execute_time_ms: 12,
        started_at: "2026-07-14T00:00:00Z",
        finished_at: "2026-07-14T00:00:01Z",
      });
    },
    async (archil, calls) => {
      const sandbox = await archil.sandbox.get("sb-1");
      const result = await sandbox.run("ls", { env: { A: "1" }, timeoutMs: 30_000, ...fastPoll });
      const submit = calls.find((c) => c.method === "POST");
      assert.equal(submit?.path, "/api/sandboxes/sb-1/execs");
      assert.deepEqual(submit?.body, { command: "ls", env: { A: "1" }, timeout_seconds: 30 });
      assert.equal(result.execId, "ex-1");
      assert.equal(result.status, "completed");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "file\n");
      assert.equal(result.executeTimeMs, 12);
    },
  );
});

test("run returns a terminal submit response without polling", async () => {
  await withStub(
    (call) => {
      if (call.path === "/api/sandboxes/sb-1") return envelope(sandboxWire());
      return envelope({
        sandbox_id: "sb-1",
        exec_id: "ex-1",
        command: "ls",
        status: "completed",
        exit_code: 0,
        stdout: "file\n",
        stderr: "",
        execute_time_ms: 3,
        started_at: "2026-07-14T00:00:00Z",
        finished_at: "2026-07-14T00:00:00Z",
      });
    },
    async (archil, calls) => {
      const sandbox = await archil.sandbox.get("sb-1");
      const result = await sandbox.run("ls", fastPoll);
      assert.equal(result.status, "completed");
      assert.equal(result.stdout, "file\n");
      assert.equal(calls.filter((c) => c.method === "GET" && /execs/.test(c.path)).length, 0);
    },
  );
});

test("run reports non-zero exit codes without throwing", async () => {
  await withStub(
    (call) => {
      if (call.path === "/api/sandboxes/sb-1") return envelope(sandboxWire());
      if (call.method === "POST") {
        return envelope(
          {
            sandbox_id: "sb-1",
            exec_id: "ex-1",
            command: "false",
            status: "running",
            started_at: "2026-07-14T00:00:00Z",
          },
          202,
        );
      }
      return envelope({
        sandbox_id: "sb-1",
        exec_id: "ex-1",
        command: "false",
        status: "completed",
        exit_code: 1,
        stdout: "",
        stderr: "boom",
        started_at: "2026-07-14T00:00:00Z",
      });
    },
    async (archil) => {
      const sandbox = await archil.sandbox.get("sb-1");
      const result = await sandbox.run("false", fastPoll);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stderr, "boom");
    },
  );
});

test("stop waits for the sandbox to become inactive", async () => {
  let refreshes = 0;
  await withStub(
    (call) => {
      if (call.method === "POST") return envelope(sandboxWire({ status: "stopping" }), 202);
      if (call.path === "/api/sandboxes/sb-1" && refreshes === 0 && call.search === "") {
        refreshes += 1;
        return envelope(sandboxWire());
      }
      refreshes += 1;
      return envelope(sandboxWire({ status: refreshes < 3 ? "stopping" : "stopped" }));
    },
    async (archil, calls) => {
      const sandbox = await archil.sandbox.get("sb-1");
      await sandbox.stop(fastPoll);
      assert.ok(calls.some((c) => c.path === "/api/sandboxes/sb-1/stop"));
      assert.equal(sandbox.status, "stopped");
    },
  );
});

test("start resumes by id and waits until running", async () => {
  await withStub(
    (call) =>
      call.method === "POST"
        ? envelope(sandboxWire({ status: "pending" }), 202)
        : envelope(sandboxWire({ status: "running" })),
    async (archil, calls) => {
      const sandbox = await archil.sandbox.start({ id: "sb-1", ...fastPoll });
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].path, "/api/sandboxes/sb-1/start");
      assert.equal(sandbox.status, "running");
    },
  );
});

test("list returns sandbox handles and filters by disk", async () => {
  await withStub(
    () => envelope({ sandboxes: [sandboxWire(), sandboxWire({ sandbox_id: "sb-2" })] }),
    async (archil, calls) => {
      const sandboxes = await archil.sandbox.list({ disk: "dsk-1" });
      assert.equal(calls[0].path, "/api/sandboxes");
      assert.equal(calls[0].search, "?filesystem=dsk-1");
      assert.deepEqual(
        sandboxes.map((s) => s.id),
        ["sb-1", "sb-2"],
      );
    },
  );
});

test("api errors surface status and message", async () => {
  await withStub(
    () => ({ status: 409, body: { success: false, error: "sandbox is still stopping" } }),
    async (archil) => {
      await assert.rejects(
        archil.sandbox.get("sb-1"),
        (err: unknown) =>
          err instanceof ArchilApiError &&
          err.status === 409 &&
          err.message === "sandbox is still stopping",
      );
    },
  );
});
