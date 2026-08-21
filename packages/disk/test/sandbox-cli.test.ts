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
  type SandboxService,
} from "../src/cli/sandbox-command.js";
import { parseCreateSandboxOptions } from "../src/cli/sandbox-options.js";

let configDirectory: string;

beforeEach(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), "sandbox-cli-test-"));
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", configDirectory);
});

afterEach(async () => {
  vi.useRealTimers();
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
    refresh: vi.fn(async function(this: Sandbox) { return this; }),
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

function harness(sandboxes: Sandbox[], options: { tty?: boolean; stdoutTty?: boolean; confirm?: boolean } = {}) {
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: options.stdoutTty ?? options.tty ?? false,
    columns: 100,
    rows: 30,
    values: [] as Array<string | Uint8Array>,
    write(data: string | Uint8Array) { this.values.push(data); return true; },
  });
  const stderr = Object.assign(new EventEmitter(), {
    isTTY: options.tty ?? false,
    columns: 100,
    values: [] as Array<string | Uint8Array>,
    write(data: string | Uint8Array) { this.values.push(data); return true; },
  });
  const stdin = new FakeInput();
  stdin.isTTY = options.tty ?? false;
  const service: SandboxService = {
    list: vi.fn(async () => sandboxes),
    get: vi.fn(async (id) => {
      const sandbox = sandboxes.find((candidate) => candidate.id === id);
      if (!sandbox) throw new Error(`No sandbox '${id}'`);
      return sandbox;
    }),
    create: vi.fn(async (request) => fakeSandbox({
      id: "sbx-created",
      name: request?.name ?? "generated",
      vcpuCount: request?.vcpuCount ?? 1,
      memSizeMiB: request?.memSizeMiB ?? 2048,
    })),
  };
  const exitCodes: number[] = [];
  const confirmations: string[] = [];
  const forcedSignals: NodeJS.Signals[] = [];
  const signals = new EventEmitter();
  let clock = 0;
  const program = createSandboxProgram({
    version: "test",
    createClient: () => ({ sandboxes: service }),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    stderr,
    signals: signals as NodeJS.Process,
    confirm: async (question) => { confirmations.push(question); return options.confirm ?? false; },
    setExitCode: (code) => exitCodes.push(code),
    forceExit: (signal) => forcedSignals.push(signal),
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });
  const run = (...args: string[]) => program.parseAsync(["node", "sandbox", "--api-key", "key-test", "--region", "test", ...args]);
  return { stdout, stderr, stdin, signals, service, exitCodes, confirmations, forcedSignals, run };
}

function text(values: Array<string | Uint8Array>): string {
  return values.map((value) => typeof value === "string" ? value : new TextDecoder().decode(value)).join("");
}

test("target resolution gets UUIDs directly and lists only for names", async () => {
  const id = "0198aabb-1234-7abc-8def-0123456789ab";
  const duplicateOne = fakeSandbox({ id, name: "same" });
  const duplicateTwo = fakeSandbox({ id: "0198aabb-1234-7abc-8def-0123456789ac", name: "same" });
  const service = {
    list: vi.fn(async () => [duplicateOne, duplicateTwo]),
    get: vi.fn(async () => duplicateOne),
    create: vi.fn(),
  } as SandboxService;
  assert.equal((await resolveSandbox(service, id)).id, id);
  assert.equal((service.get as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.equal((service.list as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  await assert.rejects(resolveSandbox(service, "missing"), /No sandbox found/);
  await assert.rejects(resolveSandbox(service, "same"), /Multiple sandboxes/);
  assert.equal((service.get as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.equal((service.list as ReturnType<typeof vi.fn>).mock.calls.length, 2);
});

test("create validates options, maps repeated values, and dispatches no-wait", async () => {
  const parsed = parseCreateSandboxOptions("agent-task", {
    vcpuCount: "32",
    memSizeMib: "65536",
    baseImage: "alpine",
    maxTtlSeconds: "600",
    maxConcurrentProcesses: "8",
    env: ["A=one", "B=two=three"],
  });
  assert.deepEqual(parsed.env, { A: "one", B: "two=three" });
  assert.throws(() => parseCreateSandboxOptions("Bad_Name", { env: [] }), /Name must/);
  assert.throws(() => parseCreateSandboxOptions("ok", { vcpuCount: "33", env: [] }), /CPU count/);
  assert.throws(() => parseCreateSandboxOptions("ok", { memSizeMib: "255", env: [] }), /Memory/);

  const cli = harness([]);
  await cli.run("create", "agent-task", "--vcpu-count", "4", "--mem-size-mib", "512", "--env", "A=b", "--no-wait");
  const create = cli.service.create as ReturnType<typeof vi.fn>;
  assert.equal(create.mock.calls[0]![0].name, "agent-task");
  assert.equal(create.mock.calls[0]![0].memSizeMiB, 512);
  assert.deepEqual(create.mock.calls[0]![1], { wait: false });

  const invalidMemory = harness([]);
  await assert.rejects(invalidMemory.run("create", "agent-task", "--mem-size-mib", "255"), /Memory/);
  assert.equal((invalidMemory.service.create as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});

test("lifecycle commands pass wait behavior and reject invalid states", async () => {
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

test("delete matches disk CLI behavior while paused cold-start requires confirmation", async () => {
  const stopped = fakeSandbox({ status: "stopped" });
  const deletion = harness([stopped]);
  await deletion.run("delete", "one", "--output", "json");
  assert.equal((stopped.delete as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.equal(JSON.parse(text(deletion.stdout.values)).deleted, true);
  assert.deepEqual(deletion.confirmations, []);

  const paused = fakeSandbox({ status: "paused" });
  const declinedStart = harness([paused], { tty: true, confirm: false });
  await declinedStart.run("start", "one");
  assert.match(text(declinedStart.stdout.values), /Cancelled cold-start/);
  assert.deepEqual(declinedStart.confirmations, ["Cold-start 'one' and discard its memory snapshot?"]);
  assert.equal((paused.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);

  const accepted = harness([paused]);
  await accepted.run("start", "one", "--yes");
  assert.deepEqual((paused.start as ReturnType<typeof vi.fn>).mock.calls[0], [{ wait: true }]);

  const redirected = fakeSandbox({ status: "paused" });
  const redirectedStart = harness([redirected], { tty: true, stdoutTty: false, confirm: true });
  await redirectedStart.run("start", "one");
  assert.deepEqual(redirectedStart.confirmations, ["Cold-start 'one' and discard its memory snapshot?"]);
  assert.deepEqual((redirected.start as ReturnType<typeof vi.fn>).mock.calls[0], [{ wait: true }]);
});

test("wait handles stable and transitional states, targets, output, and timeouts", async () => {
  const immediate = harness([fakeSandbox({ status: "running" })]);
  await immediate.run("wait", "one", "--output", "json");
  assert.equal(JSON.parse(text(immediate.stdout.values)).status, "running");

  for (const [initial, final] of [["pending", "running"], ["pausing", "paused"], ["stopping", "stopped"]] as const) {
    const item = fakeSandbox({ status: initial });
    item.refresh = vi.fn(async function(this: Sandbox) { this.status = final; return this; });
    const cli = harness([item]);
    await cli.run("wait", "one");
    assert.equal(item.status, final);
    assert.match(text(cli.stdout.values), new RegExp(final));
  }

  const targeted = fakeSandbox({ status: "paused" });
  targeted.refresh = vi.fn(async function(this: Sandbox) { this.status = "running"; return this; });
  const targetCli = harness([targeted]);
  await targetCli.run("wait", "one", "--status", "running");
  assert.equal(targeted.status, "running");

  const invalid = harness([fakeSandbox()]);
  await assert.rejects(invalid.run("wait", "one", "--status", "pending"), /Status must be one of/);
  await assert.rejects(invalid.run("wait", "one", "--timeout", "0"), /at least 1 second/);

  const pending = fakeSandbox({ status: "pending" });
  const timeoutCli = harness([pending]);
  await assert.rejects(timeoutCli.run("wait", "one", "--timeout", "1"), /current status is 'pending'/);
});

test("run preserves argv, streams output, and propagates remote status", async () => {
  const result: SandboxProcessResult = { status: "failed", exitCode: 7, stdout: "", stderr: "" };
  const closeStdin = vi.fn(async () => undefined);
  const start = vi.fn(async (_command: string, options: Parameters<Sandbox["processes"]["start"]>[1]) => {
    options?.onOutput?.({ stream: "stdout", offset: 0, data: new TextEncoder().encode("out") });
    options?.onOutput?.({ stream: "stderr", offset: 3, data: new TextEncoder().encode("err") });
    return { wait: vi.fn(async () => result), closeStdin, kill: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), stdout: "", stderr: "" };
  });
  const item = fakeSandbox({ processes: { start } as unknown as Sandbox["processes"] });
  const cli = harness([item]);
  const args = ["sh", "-c", "printf '%s\\n' \"$1\"; echo done", "", "a b", "single'quote", "double\"quote", "$HOME", "line\nfeed"];
  await cli.run("run", "one", "--env", "A=b", "--timeout", "9", "--", ...args);
  assert.equal(
    start.mock.calls[0]![0],
    `'sh' '-c' 'printf '"'"'%s\\n'"'"' "$1"; echo done' '' 'a b' 'single'"'"'quote' 'double"quote' '$HOME' 'line\nfeed'`,
  );
  assert.deepEqual(start.mock.calls[0]![1]?.env, { A: "b" });
  assert.equal(start.mock.calls[0]![1]?.timeoutSeconds, 9);
  assert.equal(start.mock.calls[0]![1]?.collectOutput, false);
  assert.equal(text(cli.stdout.values), "out");
  assert.equal(text(cli.stderr.values), "err");
  assert.equal(closeStdin.mock.calls.length, 1);
  assert.deepEqual(cli.exitCodes, [7]);

  const paused = harness([fakeSandbox({ status: "paused" })]);
  await assert.rejects(paused.run("run", "one", "echo", "no"), /while it is paused/);
});

test("run supports JSON and kills the remote process on local signals", async () => {
  const completed: SandboxProcessResult = { status: "completed", exitCode: 0, stdout: "json-out", stderr: "" };
  const jsonRemote = { wait: vi.fn(async () => completed), closeStdin: vi.fn(async () => undefined), kill: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), stdout: "json-out", stderr: "" };
  const jsonStart = vi.fn(async (_command: string, _options: Parameters<Sandbox["processes"]["start"]>[1]) => jsonRemote);
  const json = harness([fakeSandbox({ processes: { start: jsonStart } as unknown as Sandbox["processes"] })]);
  await json.run("run", "one", "echo", "ok", "--output", "json");
  assert.deepEqual(JSON.parse(text(json.stdout.values)), completed);
  assert.equal(jsonStart.mock.calls[0]![1]?.collectOutput, true);
  assert.equal(jsonStart.mock.calls[0]![1]?.onOutput, undefined);

  const wait = new Promise<SandboxProcessResult>(() => {});
  const interruptedRemote = { wait: vi.fn(() => wait), closeStdin: vi.fn(async () => undefined), kill: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), stdout: "", stderr: "" };
  const interrupted = harness([fakeSandbox({ processes: { start: vi.fn(async () => interruptedRemote) } as unknown as Sandbox["processes"] })]);
  const running = interrupted.run("run", "one", "sleep", "30");
  await vi.waitFor(() => assert.equal(interrupted.signals.listenerCount("SIGINT"), 1));
  interrupted.signals.emit("SIGINT");
  await running;
  assert.equal(interruptedRemote.kill.mock.calls.length, 1);
  assert.equal(interruptedRemote.disconnect.mock.calls.length, 1);
  assert.match(text(interrupted.stderr.values), /terminated by local signal/);
  assert.deepEqual(interrupted.exitCodes, [1]);
  assert.equal(interrupted.signals.listenerCount("SIGINT"), 0);

  let acknowledgeKill!: () => void;
  const hungKill = new Promise<void>((resolve) => { acknowledgeKill = resolve; });
  const hungRemote = { wait: vi.fn(() => wait), closeStdin: vi.fn(async () => undefined), kill: vi.fn(() => hungKill), disconnect: vi.fn(async () => undefined), stdout: "", stderr: "" };
  const hung = harness([fakeSandbox({ processes: { start: vi.fn(async () => hungRemote) } as unknown as Sandbox["processes"] })]);
  const hungRun = hung.run("run", "one", "sleep", "30");
  await vi.waitFor(() => assert.equal(hung.signals.listenerCount("SIGINT"), 1));
  hung.signals.emit("SIGINT");
  await vi.waitFor(() => assert.equal(hungRemote.kill.mock.calls.length, 1));
  hung.signals.emit("SIGINT");
  assert.deepEqual(hung.forcedSignals, ["SIGINT"]);
  acknowledgeKill();
  await hungRun;

  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const startingRemote = { wait: vi.fn(async () => completed), closeStdin: vi.fn(async () => undefined), kill: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), stdout: "", stderr: "" };
  const gatedStart = vi.fn(async () => { await startGate; return startingRemote; });
  const starting = harness([fakeSandbox({ processes: { start: gatedStart } as unknown as Sandbox["processes"] })]);
  const startingRun = starting.run("run", "one", "echo", "ok");
  await vi.waitFor(() => assert.equal(gatedStart.mock.calls.length, 1));
  assert.equal(starting.signals.listenerCount("SIGINT"), 0);
  releaseStart();
  await startingRun;
});

test("run kills the remote process if its output connection fails", async () => {
  const remote = {
    wait: vi.fn(async () => { throw new Error("connection closed"); }),
    closeStdin: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    stdout: "",
    stderr: "",
  };
  const cli = harness([fakeSandbox({ processes: { start: vi.fn(async () => remote) } as unknown as Sandbox["processes"] })]);
  await assert.rejects(cli.run("run", "one", "sleep", "30"), /connection closed/);
  assert.equal(remote.kill.mock.calls.length, 1);
  assert.equal(remote.disconnect.mock.calls.length, 1);
});

test("run reports failures without remote stderr", async () => {
  for (const [result, args, expected] of [
    [{ status: "timed_out", stdout: "", stderr: "" }, ["--timeout", "1", "--", "sleep", "5"], /Process timed out after 1 second/],
    [{ status: "failed", exitCode: 9, exitReason: "signal", stdout: "", stderr: "" }, ["false"], /Process failed with exit code 9: signal/],
    [{ status: "cancelled", exitReason: "sandbox stopped", stdout: "", stderr: "" }, ["false"], /Process cancelled: sandbox stopped/],
  ] as const) {
    const remote = { wait: vi.fn(async () => result), closeStdin: vi.fn(async () => undefined), kill: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), stdout: "", stderr: "" };
    const item = fakeSandbox({ processes: { start: vi.fn(async () => remote) } as unknown as Sandbox["processes"] });
    const cli = harness([item]);
    await cli.run("run", "one", ...args);
    assert.match(text(cli.stderr.values), expected);
    assert.deepEqual(cli.exitCodes, [result.exitCode ?? 1]);
  }
});
