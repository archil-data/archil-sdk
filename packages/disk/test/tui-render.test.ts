import assert from "node:assert/strict";
import { test } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Sandbox } from "../src/sandbox.js";
import type { SandboxModelSnapshot } from "../src/tui/model.js";
import { SandboxDetails } from "../src/tui/components/sandbox-details.js";
import { SandboxTable, safeCell } from "../src/tui/components/sandbox-table.js";
import { requireInteractiveTerminal } from "../src/tui/run.js";

const selected = {
  id: "sbx-very-long-id-with-hostile-\u001b[2J-content",
  name: "a very long sandbox name that needs truncation \u001b]0;bad\u0007",
  status: "running",
  vcpuCount: 32,
  memSizeMiB: 65536,
  baseImage: "ghcr.io/example/an-extremely-long-image-name:with-a-long-tag",
  platform: "arm64",
  maxTtlSeconds: 3600,
  maxConcurrentExecs: 8,
  endpoints: [{ port: 443, hostname: "host.example" }],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  runningAt: new Date("2026-01-01T00:00:01Z"),
  lastActiveAt: new Date("2026-01-01T00:00:02Z"),
  expiresAt: new Date("2026-01-01T01:00:00Z"),
} as Sandbox;
const snapshot: SandboxModelSnapshot = {
  sandboxes: [selected], visibleSandboxes: [selected], selected, selectedId: selected.id,
  filter: "", sort: "lastActive", loading: false, busyIds: new Set(),
};

test("sandbox table and details never exceed narrow, normal, or wide widths", () => {
  for (const width of [30, 80, 120]) {
    for (const component of [new SandboxTable(() => snapshot), new SandboxDetails(() => snapshot)]) {
      const lines = component.render(width);
      assert.ok(lines.length > 0);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    }
  }
});

test("wide table shares flexible space evenly between name and image", () => {
  const header = stripTerminalSequences(new SandboxTable(() => snapshot).render(160)[0]!);
  const nameSpan = header.indexOf("STATUS");
  const imageStart = header.indexOf("IMAGE");
  const imageSpan = header.indexOf("ACTIVE") - imageStart;
  assert.ok(Math.abs(nameSpan - imageSpan) <= 1, `${nameSpan} vs ${imageSpan}`);
});

test("API-provided cells cannot inject terminal controls", () => {
  assert.equal(safeCell("hello\u001b[2Jworld\nnext"), "helloworld next");
  const rendered = new SandboxTable(() => snapshot).render(120).join("\n");
  assert.equal(rendered.includes("\u001b]0"), false);
  assert.equal(rendered.includes("\u0007"), false);
});

test("sandbox TUI rejects non-interactive streams", () => {
  assert.throws(() => requireInteractiveTerminal(false, true), /requires an interactive terminal/);
  assert.throws(() => requireInteractiveTerminal(true, false), /requires an interactive terminal/);
  assert.doesNotThrow(() => requireInteractiveTerminal(true, true));
});
