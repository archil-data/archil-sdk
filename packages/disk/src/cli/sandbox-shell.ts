import type { SandboxProcess, SandboxProcessResult } from "../sandbox-process.js";
import type { Sandbox } from "../sandbox.js";

interface ShellInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
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
}

export async function runSandboxShell(options: SandboxShellOptions): Promise<SandboxProcessResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signals = options.signals ?? process;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("sandbox shell requires TTY stdin and stdout");

  let remote: SandboxProcess | undefined;
  let result: SandboxProcessResult | undefined;
  let terminationRequested = false;
  let terminationStarted = false;
  let terminationReason = "terminated locally";
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
  const requestTermination = (reason: string) => {
    if (terminationRequested) return;
    terminationRequested = true;
    terminationReason = reason;
    startTermination();
  };
  const onInput = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    const emergency = bytes.indexOf(0x1d);
    if (emergency >= 0) {
      if (emergency > 0) void remote!.sendInput(bytes.subarray(0, emergency)).catch(fail);
      requestTermination("terminated by Ctrl+]");
    } else {
      void remote!.sendInput(bytes).catch(fail);
    }
  };
  const onResize = () => {
    if (remote) {
      void remote.resize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 }).catch(fail);
    }
  };
  const onSignal = () => requestTermination("terminated by local signal");
  const priorRaw = stdin.isRaw ?? false;

  try {
    stdin.setRawMode(true);
    stdout.on("resize", onResize);
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);
    signals.on("SIGHUP", onSignal);
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
    stderr.write(`Archil shell process ${remote.id}; Ctrl+] exits\n`);
    stdin.on("data", onInput);
    stdin.resume();
    if (terminationRequested) startTermination();
    result = await Promise.race([remote.wait(), termination, failure]);
    failureSettled = true;
    return result;
  } finally {
    stdin.off("data", onInput);
    stdout.off("resize", onResize);
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
    signals.off("SIGHUP", onSignal);
    stdin.setRawMode(priorRaw);
    if (remote && !result && !terminationRequested) await remote.kill().catch(() => {});
    if (remote) await remote.disconnect().catch(() => {});
  }
}
