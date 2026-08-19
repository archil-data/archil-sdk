import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { Sandbox } from "../src/sandbox.js";
import { SandboxModel } from "../src/tui/model.js";

function sandbox(id: string, overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id,
    name: id,
    status: "running",
    vcpuCount: 1,
    memSizeMiB: 2048,
    baseImage: "ubuntu:26.04",
    maxTtlSeconds: 3600,
    maxConcurrentExecs: 4,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastActiveAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Sandbox;
}

afterEach(() => vi.useRealTimers());

test("model sorts, filters, and preserves selection by sandbox id", async () => {
  let items = [
    sandbox("older", { name: "Zulu", lastActiveAt: new Date("2026-01-01T00:00:00Z") }),
    sandbox("newer", { name: "Alpha", status: "paused", lastActiveAt: new Date("2026-01-02T00:00:00Z") }),
  ];
  const model = new SandboxModel({ list: async () => items });
  await model.refresh();
  assert.deepEqual(model.snapshot().visibleSandboxes.map(({ id }) => id), ["newer", "older"]);
  model.selectLast();
  assert.equal(model.snapshot().selectedId, "older");
  items = [items[1]!, items[0]!];
  await model.refresh();
  assert.equal(model.snapshot().selectedId, "older");
  model.setFilter("alpha paused");
  assert.deepEqual(model.snapshot().visibleSandboxes.map(({ id }) => id), ["newer"]);
  assert.equal(model.snapshot().selectedId, "newer");
  model.setFilter("missing");
  assert.equal(model.snapshot().selected, undefined);
  model.setFilter("");
  model.setSort("name");
  assert.deepEqual(model.snapshot().visibleSandboxes.map(({ id }) => id), ["newer", "older"]);
});

test("transient refresh errors retain the last successful data", async () => {
  let fail = false;
  const model = new SandboxModel({ list: async () => {
    if (fail) throw new Error("temporary outage");
    return [sandbox("kept")];
  } });
  await model.refresh();
  fail = true;
  await model.refresh();
  assert.equal(model.snapshot().sandboxes[0]?.id, "kept");
  assert.equal(model.snapshot().error, "temporary outage");
});

test("polling never overlaps requests and stops follow-up work", async () => {
  vi.useFakeTimers();
  let calls = 0;
  let resolve!: (value: Sandbox[]) => void;
  const model = new SandboxModel({ list: () => {
    calls++;
    return new Promise((done) => { resolve = done; });
  } }, 2_000);
  model.startPolling();
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(calls, 1);
  resolve([sandbox("one")]);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2_000);
  assert.equal(calls, 2);
  model.stopPolling();
  resolve([]);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(calls, 2);
});
