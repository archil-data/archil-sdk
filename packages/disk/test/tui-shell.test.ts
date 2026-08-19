import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import type { SandboxProcess, SandboxProcessResult } from "../src/sandbox-process.js";
import type { Sandbox } from "../src/sandbox.js";
import type { SandboxModel } from "../src/tui/model.js";
import { runShellHandoff } from "../src/tui/shell.js";

class FakeInput extends EventEmitter {
  isRaw = false;
  rawChanges: boolean[] = [];
  setRawMode(value: boolean) { this.isRaw = value; this.rawChanges.push(value); }
  resume() {}
}
class FakeOutput extends EventEmitter {
  columns = 100;
  rows = 30;
  writes: Array<string | Uint8Array> = [];
  write(data: string | Uint8Array) { this.writes.push(data); return true; }
}

function harness(processOverrides: Partial<SandboxProcess> = {}, startError?: Error) {
  const events: string[] = [];
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const signals = new EventEmitter();
  let output: ((event: { data: Uint8Array }) => void) | undefined;
  const result: SandboxProcessResult = { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  const remote = {
    id: "process-123",
    sendInput: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    wait: vi.fn(async () => result),
    disconnect: vi.fn(async () => { events.push("disconnect"); }),
    ...processOverrides,
  } as unknown as SandboxProcess;
  const sandbox = {
    processes: {
      start: vi.fn(async (_command: string, options: { onOutput?: typeof output }) => {
        events.push("process.start");
        if (startError) throw startError;
        output = options.onOutput;
        return remote;
      }),
    },
  } as unknown as Sandbox;
  const tui = {
    stop: vi.fn(() => events.push("tui.stop")),
    start: vi.fn(() => events.push("tui.start")),
    renderNow: vi.fn(() => events.push("tui.render")),
  } as unknown as TUI;
  const model = {
    stopPolling: vi.fn(() => events.push("poll.stop")),
    restartPolling: vi.fn(() => events.push("poll.start")),
    refresh: vi.fn(async () => { events.push("refresh"); }),
  } as unknown as SandboxModel;
  return { events, stdin, stdout, signals, remote, sandbox, tui, model, getOutput: () => output };
}

test("normal shell handoff stops and restores TUI, polling, raw mode, and listeners", async () => {
  const h = harness();
  const returned = await runShellHandoff({ tui: h.tui, model: h.model, sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, signals: h.signals as never });
  assert.equal(returned.processId, "process-123");
  assert.equal(returned.result?.status, "completed");
  assert.deepEqual(h.events, ["poll.stop", "tui.stop", "process.start", "disconnect", "tui.start", "tui.render", "poll.start", "refresh"]);
  assert.deepEqual(h.stdin.rawChanges, [true, false]);
  assert.equal(h.stdin.listenerCount("data"), 0);
  assert.equal(h.stdout.listenerCount("resize"), 0);
  assert.equal(h.signals.listenerCount("SIGINT"), 0);
  assert.equal(h.stdout.writes[0], "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25h");
  assert.match(String(h.stdout.writes[1]), /Archil shell process-123/);
  assert.equal(h.stdout.writes.at(-1), "\x1b[0m\x1b[?25h\x1b[?1049l");
  assert.deepEqual((h.sandbox.processes.start as ReturnType<typeof vi.fn>).mock.calls[0]![0], "/bin/sh -l");
  assert.deepEqual((h.sandbox.processes.start as ReturnType<typeof vi.fn>).mock.calls[0]![1].terminal, { cols: 100, rows: 30 });
});

test("Ctrl+] kills the remote shell while ordinary Ctrl+C and Ctrl+D are forwarded", async () => {
  let finish!: (result: SandboxProcessResult) => void;
  const waiting = new Promise<SandboxProcessResult>((resolve) => { finish = resolve; });
  const h = harness({ wait: vi.fn(() => waiting) as unknown as SandboxProcess["wait"] });
  (h.remote.kill as ReturnType<typeof vi.fn>).mockImplementation(async () => { finish({ status: "cancelled", stdout: "", stderr: "" }); });
  const handoff = runShellHandoff({ tui: h.tui, model: h.model, sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, signals: h.signals as never });
  await vi.waitFor(() => assert.equal(h.stdin.listenerCount("data"), 1));
  h.stdin.emit("data", Buffer.from([3, 4]));
  await vi.waitFor(() => assert.equal((h.remote.sendInput as ReturnType<typeof vi.fn>).mock.calls.length, 1));
  assert.deepEqual((h.remote.sendInput as ReturnType<typeof vi.fn>).mock.calls[0]![0], new Uint8Array([3, 4]));
  h.stdin.emit("data", Buffer.from([0x1d]));
  const returned = await handoff;
  assert.equal((h.remote.kill as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.equal(returned.result?.status, "cancelled");
});

test("start failure and connection closure always restore terminal ownership", async () => {
  const startFailure = harness({}, new Error("start failed"));
  await assert.rejects(runShellHandoff({ tui: startFailure.tui, model: startFailure.model, sandbox: startFailure.sandbox, stdin: startFailure.stdin, stdout: startFailure.stdout, signals: startFailure.signals as never }), /start failed/);
  assert.deepEqual(startFailure.stdin.rawChanges, [true, false]);
  assert.equal((startFailure.tui.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);

  const closed = harness({ wait: vi.fn(async () => { throw new Error("connection closed"); }) as unknown as SandboxProcess["wait"] });
  await assert.rejects(runShellHandoff({ tui: closed.tui, model: closed.model, sandbox: closed.sandbox, stdin: closed.stdin, stdout: closed.stdout, signals: closed.signals as never }), /connection closed/);
  assert.equal(closed.stdin.listenerCount("data"), 0);
  assert.equal((closed.tui.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("resize and output failures clean up without listener leaks across sessions", async () => {
  for (const failure of ["resize", "output"] as const) {
    let wait!: Promise<SandboxProcessResult>;
    wait = new Promise(() => {});
    const h = harness({
      wait: vi.fn(() => wait) as unknown as SandboxProcess["wait"],
      resize: vi.fn(async () => { if (failure === "resize") throw new Error("resize failed"); }) as unknown as SandboxProcess["resize"],
    });
    if (failure === "output") h.stdout.write = (data) => {
      if (data instanceof Uint8Array) throw new Error("output failed");
      h.stdout.writes.push(data);
      return true;
    };
    const handoff = runShellHandoff({ tui: h.tui, model: h.model, sandbox: h.sandbox, stdin: h.stdin, stdout: h.stdout, signals: h.signals as never });
    const rejected = assert.rejects(handoff, new RegExp(`${failure} failed`));
    await vi.waitFor(() => assert.ok(h.getOutput()));
    if (failure === "resize") h.stdout.emit("resize");
    else h.getOutput()!({ data: new Uint8Array([65]) });
    await rejected;
    assert.equal(h.stdin.listenerCount("data"), 0);
    assert.equal(h.stdout.listenerCount("resize"), 0);
    assert.equal((h.tui.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  }
});
