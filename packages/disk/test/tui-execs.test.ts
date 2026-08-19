import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { Sandbox, SandboxExec } from "../src/sandbox.js";
import { ExecModel, MAX_EXEC_OUTPUT_CHARS, sanitizeRemoteOutput } from "../src/tui/exec-model.js";
import { ExecTable } from "../src/tui/components/exec-table.js";
import { visibleWidth } from "@earendil-works/pi-tui";

function execution(id: string, status: SandboxExec["status"] = "completed", started = 0): SandboxExec {
  return {
    id, sandboxId: "sbx", command: id === "long" ? "echo a very long command that should truncate" : `echo ${id}`,
    status, exitCode: status === "running" ? undefined : 0, startedAt: new Date(started),
    finishedAt: status === "running" ? undefined : new Date(started + 1500),
    cancel: vi.fn(async function(this: SandboxExec) { this.status = "cancelled"; return this; }),
  } as unknown as SandboxExec;
}

function sandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: "sbx", name: "sandbox", status: "running",
    listExecs: vi.fn(async () => []), getExec: vi.fn(), exec: vi.fn(),
    ...overrides,
  } as unknown as Sandbox;
}

afterEach(() => vi.useRealTimers());

test("exec model orders history and submits only to running sandboxes", async () => {
  const old = execution("old", "completed", 100);
  const recent = execution("recent", "running", 200);
  const submit = vi.fn(async () => recent);
  const target = sandbox({ listExecs: vi.fn(async () => [old, recent]) as unknown as Sandbox["listExecs"], exec: submit as unknown as Sandbox["exec"] });
  const model = new ExecModel(target);
  await model.load();
  assert.deepEqual(model.snapshot().execs.map(({ id }) => id), ["recent", "old"]);
  assert.equal(await model.submit("echo hi"), true);
  assert.deepEqual(submit.mock.calls[0], ["echo hi", { wait: false }]);
  target.status = "paused";
  assert.equal(await model.submit("no"), false);
  assert.equal(submit.mock.calls.length, 1);
});

test("output details are fetched before display and running execs can be cancelled", async () => {
  const listed = execution("run", "running", 100);
  const detailed = { ...execution("run", "completed", 100), stdout: "done\n", stderr: "" } as SandboxExec;
  const getExec = vi.fn(async () => detailed);
  const target = sandbox({ listExecs: vi.fn(async () => [listed]) as unknown as Sandbox["listExecs"], getExec: getExec as unknown as Sandbox["getExec"] });
  const model = new ExecModel(target);
  await model.load();
  assert.equal((await model.detail())?.stdout, "done\n");
  assert.deepEqual(getExec.mock.calls[0], ["run"]);
  assert.equal(await model.cancel(), true);
  assert.equal((listed.cancel as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test("running-exec polling does not overlap and stops when the view closes", async () => {
  vi.useFakeTimers();
  let calls = 0;
  let release!: (value: SandboxExec[]) => void;
  const target = sandbox({ listExecs: (() => {
    calls++;
    if (calls === 1) return Promise.resolve([execution("run", "running")]);
    return new Promise((resolve) => { release = resolve; });
  }) as Sandbox["listExecs"] });
  const model = new ExecModel(target, 1000);
  model.startPolling();
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(calls, 2);
  model.stopPolling();
  release([execution("run", "completed")]);
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(calls, 2);
});

test("remote output strips terminal controls and enforces a display-only cap", () => {
  const safe = sanitizeRemoteOutput("hello\u001b[2J\u001b]0;owned\u0007world\nline\u0001");
  assert.equal(safe.text, "helloworld\nline�");
  const large = sanitizeRemoteOutput("x".repeat(MAX_EXEC_OUTPUT_CHARS + 100));
  assert.equal(large.truncated, true);
  assert.match(large.text, /output truncated/);
  assert.ok(large.text.length < MAX_EXEC_OUTPUT_CHARS + 100);
});

test("exec table truncates commands and every line to its allocation", () => {
  const item = execution("long", "completed", 100);
  const table = new ExecTable(() => ({ execs: [item], selected: item, loading: false }));
  for (const width of [55, 80, 120]) {
    for (const line of table.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});
