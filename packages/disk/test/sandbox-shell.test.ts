import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, vi } from "vitest";
import type { SandboxProcess, SandboxProcessResult } from "../src/sandbox-process.js";
import type { Sandbox } from "../src/sandbox.js";
import { runSandboxShell } from "../src/cli/sandbox-shell.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  pauseCalls = 0;
  rawChanges: boolean[] = [];
  private readonly pendingData: Array<Buffer | string> = [];
  setRawMode(value: boolean) { this.isRaw = value; this.rawChanges.push(value); }
  isPaused() { return this.paused; }
  override emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName === "data" && this.listenerCount("data") === 0) {
      this.pendingData.push(args[0] as Buffer | string);
      return false;
    }
    return super.emit(eventName, ...args);
  }
  resume() {
    this.paused = false;
    for (const data of this.pendingData.splice(0)) super.emit("data", data);
  }
  pause() { this.paused = true; this.pauseCalls++; }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  writes: Array<string | Uint8Array> = [];
  write(data: string | Uint8Array) { this.writes.push(data); return true; }
}

function harness(processOverrides: Partial<SandboxProcess> = {}, startError?: Error, startGate?: Promise<void>) {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const stderr = new FakeOutput();
  const signals = new EventEmitter();
  let output: ((event: { data: Uint8Array }) => void) | undefined;
  const result: SandboxProcessResult = { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  const remote = {
    id: "process-123",
    status: "running",
    sendInput: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    wait: vi.fn(async () => result),
    disconnect: vi.fn(async () => undefined),
    ...processOverrides,
  } as unknown as SandboxProcess;
  const sandbox = {
    processes: {
      start: vi.fn(async (_command: string, options: { onOutput?: typeof output }) => {
        if (startError) throw startError;
        await startGate;
        output = options.onOutput;
        return remote;
      }),
    },
  } as unknown as Sandbox;
  return { stdin, stdout, stderr, signals, remote, sandbox, getOutput: () => output };
}

test("normal shell exit restores raw mode and removes every listener", async () => {
  const h = harness();
  const result = await runSandboxShell({
    sandbox: h.sandbox,
    stdin: h.stdin,
    stdout: h.stdout,
    stderr: h.stderr,
    signals: h.signals as never,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(h.stdin.rawChanges, [true, false]);
  assert.equal(h.stdin.paused, true);
  assert.equal(h.stdin.pauseCalls, 1);
  assert.equal(h.stdin.listenerCount("data"), 0);
  assert.equal(h.stdout.listenerCount("resize"), 0);
  assert.equal(h.signals.listenerCount("SIGINT"), 0);
  assert.equal(h.signals.listenerCount("SIGTERM"), 0);
  assert.equal(h.signals.listenerCount("SIGHUP"), 0);
  assert.match(String(h.stderr.writes[0]), /process-123/);
  assert.deepEqual((h.sandbox.processes.start as ReturnType<typeof vi.fn>).mock.calls[0]![0], "/bin/sh -l");
  assert.deepEqual((h.sandbox.processes.start as ReturnType<typeof vi.fn>).mock.calls[0]![1].terminal, { cols: 100, rows: 30 });
  assert.equal((h.remote.disconnect as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("Ctrl+] returns after kill acknowledgement without waiting for a remote exit", async () => {
  const h = harness({ wait: vi.fn(() => new Promise(() => {})) as SandboxProcess["wait"] });
  const shell = runSandboxShell({ sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr, signals: h.signals as never });
  await vi.waitFor(() => assert.equal(h.stdin.listenerCount("data"), 1));
  h.stdin.emit("data", Buffer.from([3, 4]));
  await vi.waitFor(() => assert.equal((h.remote.sendInput as ReturnType<typeof vi.fn>).mock.calls.length, 1));
  assert.deepEqual((h.remote.sendInput as ReturnType<typeof vi.fn>).mock.calls[0]![0], new Uint8Array([3, 4]));
  h.stdin.emit("data", Buffer.from([65, 0x1d, 66]));
  const result = await shell;
  assert.equal(result.status, "cancelled");
  assert.equal(result.exitReason, "terminated by Ctrl+]");
  assert.deepEqual((h.remote.sendInput as ReturnType<typeof vi.fn>).mock.calls[1]![0], new Uint8Array([65]));
  assert.equal((h.remote.kill as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("input typed during startup is buffered until the remote handle exists", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({}, undefined, gate);
  const shell = runSandboxShell({ sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr, signals: h.signals as never });
  await vi.waitFor(() => assert.equal((h.sandbox.processes.start as ReturnType<typeof vi.fn>).mock.calls.length, 1));
  assert.deepEqual(h.stdin.rawChanges, []);
  assert.equal(h.stdin.listenerCount("data"), 0);
  assert.equal(h.signals.listenerCount("SIGINT"), 0);
  h.stdin.emit("data", Buffer.from("buffered\n"));
  release();
  await shell;
  assert.deepEqual((h.remote.sendInput as ReturnType<typeof vi.fn>).mock.calls[0]![0], new Uint8Array(Buffer.from("buffered\n")));
});

test("repeated termination restores the terminal before forcing exit", async () => {
  const duplicate = harness({ wait: vi.fn(() => new Promise(() => {})) as SandboxProcess["wait"] });
  const forcedSignals: NodeJS.Signals[] = [];
  const rawAtForceExit: boolean[] = [];
  const shell = runSandboxShell({
    sandbox: duplicate.sandbox,
    stdin: duplicate.stdin,
    stdout: duplicate.stdout,
    stderr: duplicate.stderr,
    signals: duplicate.signals as never,
    forceExit: (signal) => {
      forcedSignals.push(signal);
      rawAtForceExit.push(duplicate.stdin.isRaw);
    },
  });
  await vi.waitFor(() => assert.equal(duplicate.stdin.listenerCount("data"), 1));
  duplicate.stdin.emit("data", Buffer.from([0x1d]));
  duplicate.stdin.emit("data", Buffer.from([0x1d]));
  await shell;
  assert.equal((duplicate.remote.kill as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.deepEqual(forcedSignals, ["SIGTERM"]);
  assert.deepEqual(rawAtForceExit, [false]);
  assert.equal(duplicate.stdin.listenerCount("data"), 0);
  assert.equal(duplicate.stdout.listenerCount("resize"), 0);
});

test("kill failures reject after cleanup", async () => {
  const failed = harness({
    wait: vi.fn(() => new Promise(() => {})) as SandboxProcess["wait"],
    kill: vi.fn(async () => { throw new Error("kill failed"); }) as SandboxProcess["kill"],
  });
  const failing = runSandboxShell({ sandbox: failed.sandbox, stdin: failed.stdin, stdout: failed.stdout, stderr: failed.stderr, signals: failed.signals as never });
  await vi.waitFor(() => assert.equal(failed.stdin.listenerCount("data"), 1));
  failed.stdin.emit("data", Buffer.from([0x1d]));
  await assert.rejects(failing, /kill failed/);
  assert.equal(failed.stdin.listenerCount("data"), 0);
  assert.deepEqual(failed.stdin.rawChanges, [true, false]);
  assert.equal((failed.remote.disconnect as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("resize and local signals control the remote process", async () => {
  let finish!: (result: SandboxProcessResult) => void;
  const waiting = new Promise<SandboxProcessResult>((resolve) => { finish = resolve; });
  const h = harness({ wait: vi.fn(() => waiting) as SandboxProcess["wait"] });
  (h.remote.kill as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    finish({ status: "cancelled", stdout: "", stderr: "" });
  });
  const shell = runSandboxShell({ sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr, signals: h.signals as never });
  await vi.waitFor(() => assert.ok(h.getOutput()));
  h.stdout.columns = 80;
  h.stdout.rows = 24;
  h.stdout.emit("resize");
  await vi.waitFor(() => assert.equal((h.remote.resize as ReturnType<typeof vi.fn>).mock.calls.length, 1));
  assert.deepEqual((h.remote.resize as ReturnType<typeof vi.fn>).mock.calls[0]![0], { cols: 80, rows: 24 });
  h.signals.emit("SIGTERM");
  await shell;
  assert.equal(h.signals.listenerCount("SIGTERM"), 0);
});

test("startup, connection, resize, and output failures always clean up", async () => {
  const startup = harness({}, new Error("start failed"));
  await assert.rejects(runSandboxShell({ sandbox: startup.sandbox, stdin: startup.stdin, stdout: startup.stdout, stderr: startup.stderr, signals: startup.signals as never }), /start failed/);
  assert.deepEqual(startup.stdin.rawChanges, []);

  const connection = harness({ wait: vi.fn(async () => { throw new Error("connection closed"); }) as SandboxProcess["wait"] });
  await assert.rejects(runSandboxShell({ sandbox: connection.sandbox, stdin: connection.stdin, stdout: connection.stdout, stderr: connection.stderr, signals: connection.signals as never }), /connection closed/);
  assert.equal(connection.stdin.listenerCount("data"), 0);
  assert.equal((connection.remote.kill as ReturnType<typeof vi.fn>).mock.calls.length, 1);

  for (const failure of ["resize", "output"] as const) {
    const h = harness({
      wait: vi.fn(() => new Promise(() => {})) as SandboxProcess["wait"],
      resize: vi.fn(async () => { if (failure === "resize") throw new Error("resize failed"); }) as SandboxProcess["resize"],
    });
    if (failure === "output") h.stdout.write = (data) => {
      if (data instanceof Uint8Array) throw new Error("output failed");
      h.stdout.writes.push(data);
      return true;
    };
    const shell = runSandboxShell({ sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr, signals: h.signals as never });
    const rejected = assert.rejects(shell, new RegExp(`${failure} failed`));
    await vi.waitFor(() => assert.ok(h.getOutput()));
    if (failure === "resize") h.stdout.emit("resize");
    else h.getOutput()!({ data: new Uint8Array([65]) });
    await rejected;
    assert.equal(h.stdin.listenerCount("data"), 0);
    assert.equal(h.stdout.listenerCount("resize"), 0);
    assert.equal((h.remote.kill as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  }
});

test("repeated shell sessions do not leak listeners", async () => {
  const h = harness();
  for (let index = 0; index < 3; index++) {
    await runSandboxShell({ sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, stderr: h.stderr, signals: h.signals as never });
    assert.equal(h.stdin.listenerCount("data"), 0);
    assert.equal(h.stdout.listenerCount("resize"), 0);
    assert.equal(h.signals.eventNames().length, 0);
  }
});
