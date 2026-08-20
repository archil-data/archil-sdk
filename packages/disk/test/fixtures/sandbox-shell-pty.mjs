import process from "node:process";
import * as pty from "node-pty";
import { runSandboxShell } from "../../src/cli/sandbox-shell.ts";

const mode = process.argv[2];
if (mode !== "exit" && mode !== "escape") throw new Error("expected exit or escape mode");

let remote;
const sandbox = {
  processes: {
    async start(_command, options) {
      remote = pty.spawn("/bin/sh", ["-l"], {
        cols: options.terminal.cols,
        rows: options.terminal.rows,
        env: process.env,
      });
      remote.onData((data) => options.onOutput({
        stream: "stdout",
        offset: 0,
        data: new TextEncoder().encode(data),
      }));
      const exited = new Promise((resolve) => remote.onExit(({ exitCode }) => resolve({
        status: "completed",
        exitCode,
        stdout: "",
        stderr: "",
      })));
      return {
        id: `local-${mode}`,
        sendInput: async (data) => remote.write(typeof data === "string" ? data : Buffer.from(data).toString()),
        resize: async ({ cols, rows }) => remote.resize(cols, rows),
        kill: async () => remote.kill(),
        wait: () => mode === "escape" ? new Promise(() => {}) : exited,
        disconnect: async () => {},
      };
    },
  },
};

try {
  const result = await runSandboxShell({ sandbox });
  process.stdout.write(`\r\nRESULT ${result.status} RAW ${String(process.stdin.isRaw)}\r\n`, () => process.exit(0));
} catch (error) {
  process.stderr.write(`\r\nFIXTURE ERROR ${error instanceof Error ? error.stack : String(error)}\r\n`, () => process.exit(1));
}
