import { ProcessOutputBuffer } from "./process-output-buffer.js";
import type { BinaryChannel } from "./process-connection.js";
import type { Sandbox } from "./sandbox.js";

export type SandboxProcessStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SandboxProcessStream = "stdout" | "stderr";

export interface SandboxProcessOutput {
  stream: SandboxProcessStream;
  offset: number;
  data: Uint8Array;
}

export interface SandboxTerminalOptions {
  cols?: number;
  rows?: number;
}

export interface SandboxProcessConnectOptions {
  offset?: number;
  /** Retain decoded stdout and stderr on the handle and result. Defaults to true. */
  collectOutput?: boolean;
}

export interface SandboxProcessStartOptions {
  /** Absolute working directory inside the sandbox. */
  cwd?: string;
  /** Enables a PTY. PTY output is merged into stdout and stderr remains empty. */
  terminal?: boolean | SandboxTerminalOptions;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  /** Retain decoded stdout and stderr on the handle and result. Defaults to true. */
  collectOutput?: boolean;
}

export interface SandboxProcessResult {
  status: Exclude<SandboxProcessStatus, "running">;
  exitCode?: number;
  exitReason?: string;
  stdout: string;
  stderr: string;
}

type ProcessConnectionRequest =
  | {
      type: "start";
      command: string;
      cwd?: string;
      terminal?: boolean | { cols: number; rows: number };
      env: Record<string, string>;
      timeout_seconds?: number;
    }
  | { type: "attach"; process_id: string; offset: number };

export type ProcessControlRequest =
  | { type: "kill"; process_id: string }
  | {
      type: "resize";
      process_id: string;
      cols: number;
      rows: number;
    };

type ProcessControlEvent =
  | { type: "started" | "attached"; process_id: string }
  | {
      type: "exit";
      status: Exclude<SandboxProcessStatus, "running">;
      cursor: number;
      exit_code?: number | null;
      exit_reason?: string | null;
    }
  | { type: "error"; error: string; message: string };

/** @deprecated Use Sandbox.run() and Sandbox.attach(). Removed in the next version. */
export class SandboxProcesses {
  /** @internal */
  constructor(
    private readonly _sandbox: Pick<Sandbox, "run" | "attach">,
    private readonly _disconnect: () => void,
  ) {}

  /** @deprecated Use sandbox.run(). Removed in the next version. */
  start(
    command: string,
    options: SandboxProcessStartOptions = {},
  ): Promise<SandboxProcess> {
    return this._sandbox.run(command, options);
  }

  /** @deprecated Use sandbox.attach(). Removed in the next version. */
  connect(
    processId: string,
    options: SandboxProcessConnectOptions = {},
  ): Promise<SandboxProcess> {
    return this._sandbox.attach(processId, options);
  }

  /** Disconnect process transport without terminating guest processes. */
  async disconnect(): Promise<void> { this._disconnect(); }
}

export class SandboxProcess {
  status: SandboxProcessStatus = "running";
  stdout = "";
  stderr = "";
  private _id: string;
  private _cursor: number;
  private _deliveredCursor: number;
  private readonly _stdoutDecoder = new TextDecoder();
  private readonly _stderrDecoder = new TextDecoder();
  private _socket?: BinaryChannel;
  private _closed?: Promise<void>;
  private _manual = false;
  private _stdinClosed = false;
  private _iteratorTaken = false;
  private _wake?: () => void;
  private _error?: Error;
  private _exit?: Extract<ProcessControlEvent, { type: "exit" }>;
  private _result?: SandboxProcessResult;
  /** Returns each buffered binary output's credit once the iterator takes it. */
  private readonly _releases = new WeakMap<SandboxProcessOutput, () => void>();
  private _resolveDone!: () => void;
  private readonly _done = new Promise<void>((resolve) => { this._resolveDone = resolve; });

  /** Pull output from the shared buffer. One iterator may consume each handle. */
  readonly output: AsyncIterable<SandboxProcessOutput> = {
    [Symbol.asyncIterator]: () => {
      if (this._iteratorTaken) throw new Error("Process output already has a consumer");
      this._iteratorTaken = true;
      return this._iterateOutput();
    },
  };

  /** @internal */
  constructor(
    processId: string,
    cursor: number,
    private readonly _collectOutput: boolean,
    private readonly _buffer: ProcessOutputBuffer,
    private readonly _openConnection: () => Promise<BinaryChannel>,
    private readonly _controlProcess: (request: ProcessControlRequest) => Promise<void>,
  ) { this._id = processId; this._cursor = cursor; this._deliveredCursor = cursor; }

  get id(): string { return this._id; }
  /** Next byte after output accepted into the SDK buffer. */
  get cursor(): number { return this._cursor; }
  get connected(): boolean { return this._socket?.readyState === WebSocket.OPEN; }

  /** Resolves once the runtime has accepted the input; waits while the process is not reading. */
  async sendInput(data: string | Uint8Array): Promise<void> {
    if (this._stdinClosed) throw new Error("Process stdin is closed");
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    await this._openSocket().send(bytes);
  }
  async closeStdin(): Promise<void> {
    if (this._stdinClosed) return;
    this._stdinClosed = true;
    try {
      await this._openSocket().closeStdin();
    } catch (error) { this._stdinClosed = false; throw error; }
  }
  async resize(size: { cols: number; rows: number }): Promise<void> {
    if (this.status !== "running") throw new Error("Process has exited");
    await this._controlProcess({ type: "resize", process_id: this._id, ...size });
  }
  async kill(): Promise<void> {
    if (!this._exit) await this._controlProcess({ type: "kill", process_id: this._id });
  }
  async disconnect(): Promise<void> {
    this._manual = true;
    const socket = this._socket;
    socket?.close();
    await this._closed;
    if (!this._exit) this._fail(new Error("Process is disconnected"));
  }
  async wait(): Promise<SandboxProcessResult> {
    if (!this._iteratorTaken) {
      for await (const _output of this.output) { /* Collect or discard while waiting. */ }
    }
    await this._done;
    if (this._error) throw this._error;
    return this._result!;
  }
  private async *_iterateOutput(): AsyncGenerator<SandboxProcessOutput> {
    try {
      while (true) {
        const output = this._buffer.take(this);
        if (output) {
          this._releases.get(output)?.();
          this._deliveredCursor = output.offset + output.data.length;
          if (this._collectOutput) this._appendText(output.stream,
            (output.stream === "stdout" ? this._stdoutDecoder : this._stderrDecoder).decode(output.data, { stream: true }));
          this._complete();
          yield output;
        } else {
          this._complete();
          if (this._error) throw this._error;
          if (this._exit) return;
          await new Promise<void>((resolve) => { this._wake = resolve; });
          this._wake = undefined;
        }
      }
    } finally {
      if (!this._exit && !this._error) await this.disconnect();
      this._buffer.discard(this);
      this._cursor = this._deliveredCursor;
      // Output left behind no longer holds back the result.
      this._complete();
    }
  }
  /** @internal */
  async _connect(request: ProcessConnectionRequest): Promise<void> {
    const socket = await this._openConnection();
    if (this._manual) { socket.close(); throw new Error("Process is disconnected"); }
    this._socket = socket;
    let closed!: () => void;
    this._closed = new Promise<void>((resolve) => { closed = resolve; });
    const expected = request.type === "start" ? "started" : "attached";
    let settled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    socket.addEventListener("message", (message) => {
      if (this._socket !== socket) return;
      try {
        const data = message.data;
        if ("stream" in data) {
          this._enqueueOutput(data.data, data.offset, data.stream, () => socket.release(data.cost));
          return;
        }
        const event = data as ProcessControlEvent;
        switch (event.type) {
          case "started": case "attached":
            if (event.type !== expected || (this._id && this._id !== event.process_id)) throw new Error("Unexpected process identity");
            this._id = event.process_id;
            settled = true; resolveReady();
            break;
          case "exit":
            this._exit = event; this.status = event.status; this._stdinClosed = true;
            this._complete(); this._wake?.();
            break;
          case "error":
            throw new Error(`${event.error}: ${event.message}`);
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!settled) rejectReady(failure);
        this._fail(failure); socket.close();
      }
    });
    socket.addEventListener("error", () => {
      const error = new Error("Process connection failed");
      if (!settled) rejectReady(error);
      this._fail(error);
    });
    socket.addEventListener("close", () => {
      if (this._socket === socket) this._socket = undefined;
      closed();
      if (!settled) rejectReady(new Error("Process connection closed before ready"));
      if (!this._exit && !this._manual) this._fail(new Error("Process connection closed before exit"));
    }, { once: true });
    try {
      socket.sendRequest(request);
    } catch (error) { rejectReady(error instanceof Error ? error : new Error(String(error))); this._fail(error); socket.close(); }
    await ready;
  }
  private _openSocket(): BinaryChannel {
    if (this.status !== "running") throw new Error("Process has exited");
    if (!this.connected) throw new Error("Process is disconnected");
    return this._socket!;
  }
  private _fail(error: unknown): void {
    this._error ??= error instanceof Error ? error : new Error(String(error));
    this._resolveDone(); this._wake?.();
  }
  private _complete(): void {
    if (!this._exit || this._buffer.has(this) || this._result) return;
    this._flushDecoders();
    this._result = { status: this._exit.status, exitCode: this._exit.exit_code ?? undefined,
      exitReason: this._exit.exit_reason ?? undefined, stdout: this.stdout, stderr: this.stderr };
    this._resolveDone();
  }
  /** `release` returns the output's flow-control credit once it is consumed. */
  private _enqueueOutput(payload: Uint8Array, offset: number, stream: SandboxProcessStream, release: () => void): void {
    const end = offset + payload.byteLength;
    if (end <= this._cursor) { release(); return; }
    if (offset > this._cursor) throw new Error(`Process output gap: expected offset ${this._cursor}, received ${offset}`);
    const skip = this._cursor - offset;
    const output = { stream, offset: this._cursor, data: payload.slice(skip) };
    this._buffer.push(this, output);
    this._releases.set(output, release);
    this._cursor = end;
    this._wake?.();
  }
  private _appendText(stream: SandboxProcessStream, data: string): void {
    if (stream === "stdout") this.stdout += data;
    else this.stderr += data;
  }

  private _flushDecoders(): void {
    if (!this._collectOutput) return;
    this._appendText("stdout", this._stdoutDecoder.decode());
    this._appendText("stderr", this._stderrDecoder.decode());
  }

}
