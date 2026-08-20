import process from "node:process";
import { runSandboxShell } from "../../src/cli/sandbox-shell.ts";

const mode = process.argv[2];
if (mode !== "exit" && mode !== "escape") throw new Error("expected exit or escape mode");

let finish;
const exited = new Promise((resolve) => { finish = resolve; });
const sandbox = {
  processes: {
    async start(_command, options) {
      options.onOutput({ stream: "stdout", offset: 0, data: new TextEncoder().encode("$ ") });
      return {
        id: `local-${mode}`,
        sendInput: async (data) => {
          const input = typeof data === "string" ? data : Buffer.from(data).toString();
          if (input.includes("echo pty-ok")) {
            options.onOutput({ stream: "stdout", offset: 2, data: new TextEncoder().encode("pty-ok\r\n$ ") });
          }
          if (input.includes("exit")) {
            finish({ status: "completed", exitCode: 0, stdout: "", stderr: "" });
          }
        },
        resize: async () => {},
        kill: async () => {},
        wait: () => mode === "escape" ? new Promise(() => {}) : exited,
        disconnect: async () => {},
      };
    },
  },
};

try {
  const result = await runSandboxShell({ sandbox });
  process.stdout.write(`\r\nRESULT ${result.status} RAW ${String(process.stdin.isRaw)} PAUSED ${String(process.stdin.isPaused())}\r\n`);
} catch (error) {
  process.stderr.write(`\r\nFIXTURE ERROR ${error instanceof Error ? error.stack : String(error)}\r\n`);
  process.exitCode = 1;
}
