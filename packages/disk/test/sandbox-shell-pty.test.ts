import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { test } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/sandbox-shell-pty.mjs", import.meta.url));

async function runFixture(mode: "exit" | "escape"): Promise<string> {
  const terminal = pty.spawn(process.execPath, ["--experimental-strip-types", fixture, mode], {
    cols: 100,
    rows: 30,
    env: process.env,
  });
  let output = "";
  const waiters: Array<{ pattern: string; resolve: () => void }> = [];
  terminal.onData((data) => {
    output += data;
    for (const waiter of waiters.splice(0)) {
      if (output.includes(waiter.pattern)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  const waitFor = async (pattern: string) => {
    if (output.includes(pattern)) return;
    await Promise.race([
      new Promise<void>((resolve) => waiters.push({ pattern, resolve })),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out waiting for '${pattern}'. Output:\n${output}`)), 10_000)),
    ]);
  };
  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => terminal.onExit(resolve));

  try {
    await waitFor("Ctrl+] exits");
    if (mode === "exit") {
      terminal.write("echo pty-ok\r");
      await waitFor("pty-ok");
      terminal.write("exit\r");
    } else {
      terminal.write("\x1d");
    }
    const result = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`PTY fixture did not exit. Output:\n${output}`)), 10_000)),
    ]);
    assert.equal(result.exitCode, 0, output);
    return output;
  } finally {
    try { terminal.kill(); } catch {}
  }
}

test.skipIf(process.platform === "win32")("real PTY restores raw mode after ordinary exit and Ctrl+]", async () => {
  const ordinary = await runFixture("exit");
  assert.match(ordinary, /pty-ok/);
  assert.match(ordinary, /RESULT completed RAW false PAUSED true/);

  const escaped = await runFixture("escape");
  assert.match(escaped, /RESULT cancelled RAW false PAUSED true/);
}, 30_000);
