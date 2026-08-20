import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SandboxProcessResult } from "../src/sandbox-process.js";
import type { Sandbox } from "../src/sandbox.js";
import {
  createSandboxProgram,
  resolveSandbox,
  SANDBOX_ACTIONS,
  type SandboxService,
} from "../src/cli/sandbox-command.js";
import { parseCreateSandboxOptions } from "../src/cli/sandbox-options.js";

let configDirectory: string;

beforeEach(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), "sandbox-cli-test-"));
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", configDirectory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(configDirectory, { recursive: true, force: true });
});

function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: "sbx-one",
    name: "one",
    status: "running",
    vcpuCount: 2,
    memSizeMiB: 2048,
    baseImage: "ubuntu:26.04",
    platform: "arm64",
    maxTtlSeconds: 3600,
    maxConcurrentExecs: 4,
    endpoints: [{ port: 8080, hostname: "one.example" }],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastActiveAt: new Date("2026-01-02T00:00:00Z"),
    start: vi.fn(async function(this: Sandbox) { return this; }),
    pause: vi.fn(async function(this: Sandbox) { return this; }),
    resume: vi.fn(async function(this: Sandbox) { return this; }),
    stop: vi.fn(async function(this: Sandbox) { return this; }),
    fork: vi.fn(async () => fakeSandbox({ id: "sbx-fork", name: "fork" })),
    delete: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({ status: "completed", exitCode: 0, stdout: "", stderr: "" })),
    processes: { start: vi.fn() },
    ...overrides,
  } as unknown as Sandbox;
}

class FakeInput extends EventEmitter {
  isTTY = false;
  isRaw = false;
  setRawMode(value: boolean) { this.isRaw = value; }
  resume() {}
}

function harness(sandboxes: Sandbox[], options: { tty?: boolean; confirm?: boolean } = {}) {
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: options.tty ?? false,
    columns: 100,
    rows: 30,
    values: [] as Array<string | Uint8Array>,
    write(data: string | Uint8Array) { this.values.push(data); return true; },
  });
  const stderr = {
    values: [] as Array<string | Uint8Array>,
    write(data: string | Uint8Array) { this.values.push(data); return true; },
  };
  const stdin = new FakeInput();
  stdin.isTTY = options.tty ?? false;
  const service: SandboxService = {
    list: vi.fn(async () => sandboxes),
    create: vi.fn(async (request) => fakeSandbox({
      id: "sbx-created",
      name: request?.name ?? "generated",
      vcpuCount: request?.vcpuCount ?? 1,
      memSizeMiB: request?.memSizeMiB ?? 2048,
    })),
  };
  const exitCodes: number[] = [];
  const confirmations: string[] = [];
  const program = createSandboxProgram({
    version: "test",
    createClient: () => ({ sandboxes: service }),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    stderr,
    signals: new EventEmitter() as NodeJS.Process,
    confirm: async (question) => { confirmations.push(question); return options.confirm ?? false; },
    setExitCode: (code) => exitCodes.push(code),
  });
  const run = (...args: string[]) => program.parseAsync(["node", "sandbox", "--api-key", "key-test", "--region", "test", ...args]);
  return { stdout, stderr, stdin, service, exitCodes, confirmations, run };
}

function text(values: Array<string | Uint8Array>): string {
  return values.map((value) => typeof value === "string" ? value : new TextDecoder().decode(value)).join("");
}

test("list is deterministic and get supports JSON", async () => {
  const older = fakeSandbox({ id: "sbx-old", name: "old", lastActiveAt: new Date("2025-01-01T00:00:00Z") });
  const newer = fakeSandbox({ id: "sbx-new", name: "new", lastActiveAt: new Date("2026-01-01T00:00:00Z") });
  const list = harness([older, newer]);
  await list.run("list");
  assert.ok(text(list.stdout.values).indexOf("sbx-new") < text(list.stdout.values).indexOf("sbx-old"));

  const get = harness([older, newer]);
  await get.run("get", "new", "--output", "json");
  assert.equal(JSON.parse(text(get.stdout.values)).id, "sbx-new");
});

test("target resolution prefers IDs and reports missing and ambiguous names", async () => {
  const duplicateOne = fakeSandbox({ id: "sbx-a", name: "same" });
  const duplicateTwo = fakeSandbox({ id: "sbx-b", name: "same" });
  const service = { list: async () => [duplicateOne, duplicateTwo], create: vi.fn() } as SandboxService;
  assert.equal((await resolveSandbox(service, "sbx-b")).id, "sbx-b");
  await assert.rejects(resolveSandbox(service, "missing"), /No sandbox found/);
  await assert.rejects(resolveSandbox(service, "same"), /Multiple sandboxes/);
});

test("create validates options, maps repeated values, and dispatches no-wait", async () => {
  const parsed = parseCreateSandboxOptions("agent-task", {
    vcpuCount: "32",
    memSizeMiB: "65536",
    baseImage: "alpine",
    maxTtlSeconds: "600",
    maxConcurrentProcesses: "8",
    port: ["80", "53/udp"],
    env: ["A=one", "B=two=three"],
  });
  assert.deepEqual(parsed.portMappings, [
    { containerPort: 80, protocol: "tcp" },
    { containerPort: 53, protocol: "udp" },
  ]);
  assert.deepEqual(parsed.env, { A: "one", B: "two=three" });
  assert.throws(() => parseCreateSandboxOptions("Bad_Name", { port: [], env: [] }), /Name must/);
  assert.throws(() => parseCreateSandboxOptions("ok", { vcpuCount: "33", port: [], env: [] }), /CPU count/);
  assert.throws(() => parseCreateSandboxOptions("ok", { memSizeMiB: "255", port: [], env: [] }), /Memory/);
  assert.throws(() => parseCreateSandboxOptions("ok", { port: ["70000"], env: [] }), /ports from/);

  const cli = harness([]);
  await cli.run("create", "agent-task", "--vcpu-count", "4", "--port", "8080/tcp", "--env", "A=b", "--no-wait");
  const create = cli.service.create as ReturnType<typeof vi.fn>;
  assert.equal(create.mock.calls[0]![0].name, "agent-task");
  assert.deepEqual(create.mock.calls[0]![0].portMappings, [{ containerPort: 8080, protocol: "tcp" }]);
  assert.deepEqual(create.mock.calls[0]![1], { wait: false });
});

test("state matrix covers every state and lifecycle passes wait behavior", async () => {
  assert.deepEqual(SANDBOX_ACTIONS, {
    running: ["pause", "stop", "fork"],
    paused: ["resume", "start", "stop", "fork"],
    stopped: ["start", "fork", "delete"],
    exited: ["start", "delete"],
    failed: ["start", "delete"],
    pending: [], pausing: [], stopping: [], deleting: [], deleted: [],
  });
  for (const [action, status] of [["start", "stopped"], ["pause", "running"], ["resume", "paused"], ["stop", "running"]] as const) {
    const item = fakeSandbox({ status });
    const cli = harness([item]);
    await cli.run(action, "one", "--no-wait");
    assert.deepEqual((item[action] as ReturnType<typeof vi.fn>).mock.calls[0], [{ wait: false }]);
  }

  const source = fakeSandbox({ status: "stopped" });
  const fork = harness([source]);
  await fork.run("fork", "one", "valid-fork", "--no-wait");
  assert.deepEqual((source.fork as ReturnType<typeof vi.fn>).mock.calls[0], [{ name: "valid-fork", wait: false }]);

  const invalid = harness([fakeSandbox({ status: "pending" })]);
  await assert.rejects(invalid.run("stop", "one"), /while it is pending/);
});

test("delete and paused cold-start enforce confirmations without dispatching on decline", async () => {
  const stopped = fakeSandbox({ status: "stopped" });
  const noninteractive = harness([stopped]);
  await assert.rejects(noninteractive.run("delete", "one"), /requires --yes/);
  assert.equal((stopped.delete as ReturnType<typeof vi.fn>).mock.calls.length, 0);

  const declinedDelete = harness([stopped], { tty: true, confirm: false });
  await declinedDelete.run("delete", "one");
  assert.match(text(declinedDelete.stdout.values), /Cancelled deletion/);
  assert.deepEqual(declinedDelete.confirmations, ["Delete sandbox 'one' permanently?"]);
  assert.equal((stopped.delete as ReturnType<typeof vi.fn>).mock.calls.length, 0);

  const paused = fakeSandbox({ status: "paused" });
  const declinedStart = harness([paused], { tty: true, confirm: false });
  await declinedStart.run("start", "one");
  assert.match(text(declinedStart.stdout.values), /Cancelled cold-start/);
  assert.deepEqual(declinedStart.confirmations, ["Cold-start 'one' and discard its memory snapshot?"]);
  assert.equal((paused.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);

  const accepted = harness([paused]);
  await accepted.run("start", "one", "--yes");
  assert.deepEqual((paused.start as ReturnType<typeof vi.fn>).mock.calls[0], [{ wait: true }]);

  const deleted = fakeSandbox({ status: "stopped" });
  const confirmedDelete = harness([deleted]);
  await confirmedDelete.run("delete", "one", "--yes", "--output", "json");
  assert.equal((deleted.delete as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.equal(JSON.parse(text(confirmedDelete.stdout.values)).deleted, true);
});

test("run uses one-shot exec, streams both outputs, and propagates status", async () => {
  const result: SandboxProcessResult = { status: "failed", exitCode: 7, stdout: "", stderr: "" };
  const exec = vi.fn(async (_command: string, options: Parameters<Sandbox["exec"]>[1]) => {
    options?.onOutput?.({ stream: "stdout", offset: 0, data: new TextEncoder().encode("out") });
    options?.onOutput?.({ stream: "stderr", offset: 3, data: new TextEncoder().encode("err") });
    return result;
  });
  const item = fakeSandbox({ exec: exec as Sandbox["exec"] });
  const cli = harness([item]);
  await cli.run("run", "one", "--env", "A=b", "--timeout", "9", "--", "sh", "-c", "exit 7");
  assert.equal(exec.mock.calls[0]![0], "sh -c exit 7");
  assert.deepEqual(exec.mock.calls[0]![1]?.env, { A: "b" });
  assert.equal(exec.mock.calls[0]![1]?.timeoutSeconds, 9);
  assert.equal(exec.mock.calls[0]![1]?.collectOutput, false);
  assert.equal(text(cli.stdout.values), "out");
  assert.equal(text(cli.stderr.values), "err");
  assert.deepEqual(cli.exitCodes, [7]);

  const paused = harness([fakeSandbox({ status: "paused" })]);
  await assert.rejects(paused.run("run", "one", "echo", "no"), /while it is paused/);

  const timedOut = fakeSandbox({ exec: vi.fn(async () => ({ status: "timed_out", stdout: "", stderr: "" })) as Sandbox["exec"] });
  const noRemoteCode = harness([timedOut]);
  await noRemoteCode.run("run", "one", "sleep", "60");
  assert.deepEqual(noRemoteCode.exitCodes, [1]);
});
