import type { TUI } from "@earendil-works/pi-tui";
import type { SandboxProcess, SandboxProcessResult } from "../sandbox-process.js";
import type { Sandbox } from "../sandbox.js";
import type { SandboxModel } from "./model.js";

interface ShellInput {
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  off(event: "data", listener: (data: Buffer | string) => void): unknown;
}

interface ShellOutput {
  columns?: number;
  rows?: number;
  write(data: string | Uint8Array): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ShellHandoffOptions {
  tui: TUI;
  model: SandboxModel;
  sandbox: Sandbox;
  stdin?: ShellInput;
  stdout?: ShellOutput;
  signals?: SignalSource;
}

export interface ShellHandoffResult {
  processId?: string;
  result?: SandboxProcessResult;
}

export async function runShellHandoff(options: ShellHandoffOptions): Promise<ShellHandoffResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signals = options.signals ?? process;
  let remote: SandboxProcess | undefined;
  let processId: string | undefined;
  let result: SandboxProcessResult | undefined;
  let shellRaw = false;
  let shellScreenActive = false;
  let failureSettled = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const fail = (error: unknown) => {
    if (failureSettled) return;
    failureSettled = true;
    rejectFailure(error instanceof Error ? error : new Error(String(error)));
  };
  const onInput = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    const emergency = bytes.indexOf(0x1d);
    if (emergency >= 0) {
      const forwarded = new Uint8Array(bytes.length - 1);
      forwarded.set(bytes.subarray(0, emergency));
      forwarded.set(bytes.subarray(emergency + 1), emergency);
      if (forwarded.length) void remote?.sendInput(forwarded).catch(fail);
      void remote?.kill().catch(fail);
    } else {
      void remote?.sendInput(bytes).catch(fail);
    }
  };
  const onResize = () => {
    if (!remote) return;
    void remote.resize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 }).catch(fail);
  };
  const onSignal = () => { void remote?.kill().catch(fail); };

  options.model.stopPolling();
  options.tui.stop({ preserveScreen: true });
  const priorRaw = stdin.isRaw ?? false;
  try {
    stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25h");
    shellScreenActive = true;
    stdin.setRawMode(true);
    shellRaw = true;
    stdin.resume();
    stdin.on("data", onInput);
    stdout.on("resize", onResize);
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    remote = await options.sandbox.processes.start("/bin/sh -l", {
      terminal: { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 },
      collectOutput: false,
      onOutput: ({ data }) => {
        try { stdout.write(data); } catch (error) { fail(error); }
      },
    });
    processId = remote.id;
    stdout.write(`\r\n[Archil shell ${processId}; Ctrl+] returns to sandboxes]\r\n`);
    result = await Promise.race([remote.wait(), failure]);
    failureSettled = true;
    return { processId, result };
  } finally {
    stdin.off("data", onInput);
    stdout.off("resize", onResize);
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
    if (shellRaw) stdin.setRawMode(priorRaw);
    if (remote) await remote.disconnect().catch(() => {});
    if (shellScreenActive) {
      try { stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l"); } catch {}
    }
    options.tui.start();
    options.tui.renderNow(true);
    options.model.restartPolling();
    await options.model.refresh();
  }
}
