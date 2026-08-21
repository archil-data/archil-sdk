import type { SandboxProcess, SandboxProcessResult } from "../sandbox-process.js";
import type { Sandbox } from "../sandbox.js";

interface ShellInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (data: Buffer | string) => void): unknown;
  off(event: "data", listener: (data: Buffer | string) => void): unknown;
}

interface ShellOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(data: string | Uint8Array): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

interface ShellErrorOutput {
  write(data: string): unknown;
}

interface SignalSource {
  on(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
}

export interface SandboxShellOptions {
  sandbox: Sandbox;
  stdin?: ShellInput;
  stdout?: ShellOutput;
  stderr?: ShellErrorOutput;
  signals?: SignalSource;
  forceExit?: (signal: NodeJS.Signals) => void;
}

export async function runSandboxShell(options: SandboxShellOptions): Promise<SandboxProcessResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signals = options.signals ?? process;
  const forceExit = options.forceExit ?? (options.signals ? (() => {}) : (signal: NodeJS.Signals) => { process.kill(process.pid, signal); });
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("sandbox shell requires TTY stdin and stdout");

  let remote: SandboxProcess | undefined;
  let result: SandboxProcessResult | undefined;
  let terminationRequested = false;
  let terminationStarted = false;
  let terminationReason = "terminated locally";
  let terminalConfigured = false;
  let failureSettled = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const fail = (error: unknown) => {
    if (failureSettled) return;
    failureSettled = true;
    rejectFailure(error instanceof Error ? error : new Error(String(error)));
  };
  let resolveTermination!: (value: SandboxProcessResult) => void;
  let rejectTermination!: (error: Error) => void;
  const termination = new Promise<SandboxProcessResult>((resolve, reject) => {
    resolveTermination = resolve;
    rejectTermination = reject;
  });
  const startTermination = () => {
    if (!remote || terminationStarted) return;
    terminationStarted = true;
    void remote.kill().then(
      () => resolveTermination({ status: "cancelled", exitReason: terminationReason, stdout: "", stderr: "" }),
      (error: unknown) => rejectTermination(error instanceof Error ? error : new Error(String(error))),
    );
  };
  const removeSignalListeners = () => {
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
    signals.off("SIGHUP", onSighup);
  };
  const requestTermination = (reason: string, signal?: NodeJS.Signals) => {
    if (terminationRequested) {
      if (signal) {
        stdin.off("data", onInput);
        stdout.off("resize", onResize);
        removeSignalListeners();
        if (terminalConfigured) {
          stdin.setRawMode(priorRaw);
          terminalConfigured = false;
        }
        stdin.pause();
        forceExit(signal);
      }
      return;
    }
    terminationRequested = true;
    terminationReason = reason;
    startTermination();
  };
  const onInput = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    const emergency = bytes.indexOf(0x1d);
    if (emergency >= 0) {
      if (emergency > 0) void remote!.sendInput(bytes.subarray(0, emergency)).catch(fail);
      requestTermination("terminated by Ctrl+]", "SIGTERM");
    } else {
      void remote!.sendInput(bytes).catch(fail);
    }
  };
  const onResize = () => {
    if (remote) {
      void remote.resize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 }).catch(fail);
    }
  };
  const onSigint = () => requestTermination("terminated by local signal", "SIGINT");
  const onSigterm = () => requestTermination("terminated by local signal", "SIGTERM");
  const onSighup = () => requestTermination("terminated by local signal", "SIGHUP");
  const priorRaw = stdin.isRaw ?? false;

  try {
    remote = await options.sandbox.processes.start("/bin/sh -l", {
      terminal: { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 },
      collectOutput: false,
      onOutput: ({ data }) => {
        try {
          stdout.write(data);
        } catch (error) {
          fail(error);
        }
      },
    });
    stdin.setRawMode(true);
    terminalConfigured = true;
    stdout.on("resize", onResize);
    signals.on("SIGINT", onSigint);
    signals.on("SIGTERM", onSigterm);
    signals.on("SIGHUP", onSighup);
    stderr.write(`Archil shell process ${remote.id}; Ctrl+] exits\n`);
    stdin.on("data", onInput);
    stdin.resume();
    result = await Promise.race([remote.wait(), termination, failure]);
    failureSettled = true;
    return result;
  } finally {
    stdin.off("data", onInput);
    stdout.off("resize", onResize);
    removeSignalListeners();
    if (terminalConfigured) stdin.setRawMode(priorRaw);
    stdin.pause();
    if (remote && !result && !terminationRequested) await remote.kill().catch(() => {});
    if (remote) await remote.disconnect().catch(() => {});
  }
}
