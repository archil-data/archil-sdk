import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Sandbox } from "../src/sandbox.js";
import { ACTIONS_BY_STATUS, parseCreateSandboxForm } from "../src/tui/actions.js";
import { SandboxApp } from "../src/tui/app.js";
import { SandboxModel } from "../src/tui/model.js";

function sandbox(status: Sandbox["status"] = "running", methods: Partial<Sandbox> = {}): Sandbox {
  return {
    id: "sbx-one", name: "one", status, vcpuCount: 2, memSizeMiB: 2048,
    baseImage: "ubuntu:26.04", maxTtlSeconds: 3600, maxConcurrentExecs: 4,
    createdAt: new Date(), lastActiveAt: new Date(),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined), fork: vi.fn(async () => sandbox("pending")), delete: vi.fn(async () => undefined),
    ...methods,
  } as unknown as Sandbox;
}

test("action matrix covers every sandbox state", () => {
  assert.deepEqual(Object.keys(ACTIONS_BY_STATUS).sort(), ["deleted", "deleting", "exited", "failed", "paused", "pausing", "pending", "running", "stopped", "stopping"]);
  assert.deepEqual(ACTIONS_BY_STATUS.running, ["pause", "stop", "fork"]);
  assert.deepEqual(ACTIONS_BY_STATUS.paused, ["resume", "start", "stop", "fork"]);
  assert.deepEqual(ACTIONS_BY_STATUS.stopped, ["start", "fork", "delete"]);
  assert.deepEqual(ACTIONS_BY_STATUS.exited, ["start", "delete"]);
  assert.deepEqual(ACTIONS_BY_STATUS.failed, ["start", "delete"]);
  for (const status of ["pending", "pausing", "stopping", "deleting", "deleted"] as const) assert.deepEqual(ACTIONS_BY_STATUS[status], []);
});

test("create form validates OpenAPI boundaries and parses ports and environment", () => {
  const valid = parseCreateSandboxForm({
    name: "agent-task", vcpuCount: "32", memSizeMiB: "65536", baseImage: "",
    maxTtlSeconds: "600", maxConcurrentExecs: "8", portMappings: "80/tcp,53/udp", env: "A=one,B=two=three",
  });
  assert.deepEqual(valid, {
    name: "agent-task", vcpuCount: 32, memSizeMiB: 65536, baseImage: "ubuntu:26.04",
    maxTtlSeconds: 600, maxConcurrentExecs: 8,
    portMappings: [{ containerPort: 80, protocol: "tcp" }, { containerPort: 53, protocol: "udp" }],
    env: { A: "one", B: "two=three" },
  });
  for (const [field, value, message] of [["vcpuCount", "0", /CPU count/], ["vcpuCount", "33", /CPU count/], ["memSizeMiB", "255", /Memory/], ["memSizeMiB", "65537", /Memory/]] as const) {
    assert.throws(() => parseCreateSandboxForm({ name: "", vcpuCount: "1", memSizeMiB: "256", baseImage: "", maxTtlSeconds: "", maxConcurrentExecs: "", portMappings: "", env: "", [field]: value }), message);
  }
  assert.throws(() => parseCreateSandboxForm({ name: "Bad_Name", vcpuCount: "1", memSizeMiB: "256", baseImage: "", maxTtlSeconds: "", maxConcurrentExecs: "", portMappings: "", env: "" }), /Name must/);
  assert.throws(() => parseCreateSandboxForm({ name: "ok", vcpuCount: "1", memSizeMiB: "256", baseImage: "", maxTtlSeconds: "", maxConcurrentExecs: "", portMappings: "70000", env: "" }), /ports from/);
});

test("lifecycle dispatch uses wait:false and busy rows de-duplicate presses", async () => {
  let release!: () => void;
  const stop = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const item = sandbox("running", { stop: stop as unknown as Sandbox["stop"] });
  const model = new SandboxModel({ list: async () => [item] });
  await model.refresh();
  const first = model.performAction("stop");
  const duplicate = await model.performAction("stop");
  assert.equal(duplicate, false);
  assert.equal(stop.mock.calls.length, 1);
  assert.deepEqual(stop.mock.calls[0], [{ wait: false }]);
  assert.equal(model.snapshot().busyIds.has(item.id), true);
  release();
  assert.equal(await first, true);
  assert.equal(model.snapshot().busyIds.has(item.id), false);
});

test("stop confirmation can be cancelled or accepted and names the target", async () => {
  const stop = vi.fn(async () => undefined);
  const item = sandbox("running", { stop: stop as unknown as Sandbox["stop"] });
  const model = new SandboxModel({ list: async () => [item] });
  await model.refresh();
  let overlay: Component | undefined;
  const handle = { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => true };
  const tui = { requestRender: vi.fn(), showOverlay: (component: Component) => { overlay = component; return handle; } } as unknown as TUI;
  const app = new SandboxApp(tui, model, { region: "test", onQuit: () => {} });
  app.handleInput("X");
  assert.match(overlay!.render(80)[0]!, /Stop sandbox 'one'/);
  overlay!.handleInput!("n");
  assert.equal(stop.mock.calls.length, 0);
  app.handleInput("X");
  overlay!.handleInput!("y");
  await vi.waitFor(() => assert.equal(stop.mock.calls.length, 1));
  app.dispose();
});
