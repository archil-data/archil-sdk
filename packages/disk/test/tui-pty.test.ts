import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Terminal } from "@xterm/headless";
import * as pty from "node-pty";
import { beforeAll, test } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const fixture = resolve(packageRoot, ".tui-fixture-dist", "tui-fixture.mjs");

beforeAll(() => {
  if (!existsSync(fixture)) {
    const built = spawnSync("pnpm", ["build:tui-fixture"], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
  }
});

function screen(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < terminal.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  return lines.join("\n");
}

async function waitForScreen(terminal: Terminal, expected: RegExp, timeoutMs = 5000): Promise<string> {
  return waitForScreenState(terminal, (value) => expected.test(value), String(expected), timeoutMs);
}

async function waitForScreenState(terminal: Terminal, predicate: (value: string) => boolean, description: string, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = screen(terminal);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}; screen:\n${screen(terminal)}`);
}

test.skipIf(process.platform !== "linux")("built fixture TUI supports navigation, filtering, resize, modal close, and clean exit", { timeout: 15_000 }, async () => {
  const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true });
  const child = pty.spawn(process.execPath, [fixture], {
    name: "xterm-256color", cols: 120, rows: 36, cwd: packageRoot,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  const data = child.onData((chunk) => terminal.write(chunk));
  try {
    let rendered = await waitForScreen(terminal, /ARCHIL SANDBOXES/);
    assert.match(rendered, /fixture-running/);
    assert.match(rendered, /fixture-paused/);
    const initialHeader = rendered.split("\n").find((line) => line.includes("NAME") && line.includes("STATUS"));
    assert.ok(initialHeader);
    const statusColumn = initialHeader.indexOf("STATUS");

    child.write("\x1b[B");
    rendered = await waitForScreen(terminal, /▸ fixture-paused/);
    const movedHeader = rendered.split("\n").find((line) => line.includes("NAME") && line.includes("STATUS"));
    assert.equal(movedHeader?.indexOf("STATUS"), statusColumn);
    child.write("?");
    await waitForScreen(terminal, /SANDBOX KEYS/);
    child.write("\x1b");
    rendered = await waitForScreenState(terminal, (value) => value.includes("ARCHIL SANDBOXES") && !value.includes("SANDBOX KEYS"), "help overlay to close");

    child.write("/");
    rendered = await waitForScreen(terminal, /FILTER/);
    assert.doesNotMatch(rendered, /q quit/);
    child.write("failed");
    rendered = await waitForScreenState(terminal, (value) => value.includes("fixture-failed") && !value.includes("fixture-running"), "live filtered sandbox list");
    assert.match(rendered, /FILTER > failed/);
    child.write("\r");
    rendered = await waitForScreenState(terminal, (value) => !value.includes("Enter/Esc done") && value.includes("/ filter (failed)"), "filter bar to close");
    const detailsCount = rendered.match(/DETAILS/g)?.length ?? 0;
    child.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((screen(terminal).match(/DETAILS/g)?.length ?? 0), detailsCount);

    child.resize(80, 24);
    terminal.resize(80, 24);
    rendered = await waitForScreen(terminal, /DETAILS/);
    assert.match(rendered, /fixture-failed/);

    const exited = new Promise<number>((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
    child.write("q");
    assert.equal(await exited, 0);
    rendered = await waitForScreen(terminal, /fixture-before/);
    assert.doesNotMatch(rendered, /Archil Sandboxes|ARCHIL SANDBOXES/);
  } finally {
    data.dispose();
    terminal.dispose();
    try { child.kill(); } catch { /* already exited */ }
  }
});

test.skipIf(process.platform !== "linux")("interactive shell renders output beyond the terminal height and returns to the TUI", { timeout: 15_000 }, async () => {
  const terminal = new Terminal({ cols: 80, rows: 18, allowProposedApi: true, scrollback: 1_000 });
  const child = pty.spawn(process.execPath, [fixture], {
    name: "xterm-256color", cols: 80, rows: 18, cwd: packageRoot,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  const data = child.onData((chunk) => terminal.write(chunk));
  try {
    await waitForScreen(terminal, /ARCHIL SANDBOXES/);
    child.write("t");
    await waitForScreen(terminal, /Archil shell process-/);
    child.write("overflow\r");
    const rendered = await waitForScreen(terminal, /OVERFLOW-080/);
    assert.match(rendered, /OVERFLOW-080/);
    child.write("\x1d");
    await waitForScreen(terminal, /ARCHIL SANDBOXES/);
    const exited = new Promise<number>((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
    child.write("q");
    assert.equal(await exited, 0);
  } finally {
    data.dispose();
    terminal.dispose();
    try { child.kill(); } catch { /* already exited */ }
  }
});
