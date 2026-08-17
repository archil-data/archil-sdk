import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";

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

export type SandboxProcessOutputHandler = (output: SandboxProcessOutput) => void;

export interface SandboxTerminalOptions {
  cols?: number;
  rows?: number;
}

export interface SandboxProcessConnectOptions {
  offset?: number;
  onOutput?: SandboxProcessOutputHandler;
}

export interface SandboxProcessStartOptions {
  /** Enables a PTY. PTY output is merged into stdout and stderr remains empty. */
  terminal?: boolean | SandboxTerminalOptions;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  onOutput?: SandboxProcessOutputHandler;
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
      terminal?: boolean | { cols: number; rows: number };
      env: Record<string, string>;
      timeout_seconds?: number;
    }
  | { type: "attach"; process_id: string; offset: number };

type ProcessControlEvent =
  | { type: "started" | "attached"; process_id: string }
  | { type: "input_accepted" | "input_backpressure" | "input_closed" }
  | {
      type: "exit";
      status: Exclude<SandboxProcessStatus, "running">;
      cursor: number;
      exit_code?: number | null;
      exit_reason?: string | null;
    }
  | { type: "error"; error: string; message: string };

const PROCESS_STDIN_CHUNK_BYTES = 1024 * 1024;
const PROCESS_STDIN_RETRY_DELAY_MS = 10;

function processConnectionUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}protocol=process-v1`;
}

export class SandboxProcesses {
  private readonly _sandboxId: string;
  private readonly _client: ApiClient;

  /** @internal */
  constructor(sandboxId: string, client: ApiClient) {
    this._sandboxId = sandboxId;
    this._client = client;
  }

  async start(
    command: string,
    options: SandboxProcessStartOptions = {},
  ): Promise<SandboxProcess> {
    const process = new SandboxProcess("", 0, options.onOutput, () =>
      this._connectionUrl(),
    );
    const terminal =
      typeof options.terminal === "object"
        ? {
            cols: options.terminal.cols ?? 80,
            rows: options.terminal.rows ?? 24,
          }
        : options.terminal;
    await process._connect({
      type: "start",
      command,
      terminal,
      env: options.env ?? {},
      timeout_seconds: options.timeoutSeconds,
    });
    return process;
  }

  async connect(
    processId: string,
    options: SandboxProcessConnectOptions = {},
  ): Promise<SandboxProcess> {
    const offset = options.offset ?? 0;
    const process = new SandboxProcess(processId, offset, options.onOutput, () =>
      this._connectionUrl(),
    );
    await process._connect({ type: "attach", process_id: processId, offset });
    return process;
  }

  private async _connectionUrl(): Promise<string> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/connections", {
        params: { path: { sid: this._sandboxId } },
      }),
    );
    return processConnectionUrl(data.url);
  }
}

export class SandboxProcess {
  status: SandboxProcessStatus = "running";
  stdout = "";
  stderr = "";

  private _id: string;
  private _cursor: number;
  private readonly _onOutput?: SandboxProcessOutputHandler;
  private readonly _connectionUrl: () => Promise<string>;
  private readonly _stdoutDecoder = new TextDecoder();
  private readonly _stderrDecoder = new TextDecoder();
  private readonly _terminal: Promise<SandboxProcessResult>;
  private _resolveTerminal!: (result: SandboxProcessResult) => void;
  private _result?: SandboxProcessResult;
  private _socket?: WebSocket;
  private _connectionClosed?: Promise<void>;
  private _stdinTail: Promise<void> = Promise.resolve();
  private _stdinClosed = false;
  private _pendingInput?: {
    resolve: (accepted: boolean) => void;
    reject: (error: Error) => void;
  };

  /** @internal */
  constructor(
    processId: string,
    cursor: number,
    onOutput: SandboxProcessOutputHandler | undefined,
    connectionUrl: () => Promise<string>,
  ) {
    this._id = processId;
    this._cursor = cursor;
    this._onOutput = onOutput;
    this._connectionUrl = connectionUrl;
    this._terminal = new Promise((resolve) => {
      this._resolveTerminal = resolve;
    });
  }

  get id(): string {
    return this._id;
  }

  get cursor(): number {
    return this._cursor;
  }

  get connected(): boolean {
    return this._socket?.readyState === WebSocket.OPEN;
  }

  sendInput(data: string | Uint8Array): Promise<void> {
    if (this._stdinClosed) {
      return Promise.reject(new Error("Process stdin is closed"));
    }
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data);
    return this._queueStdin(() => this._sendInput(bytes));
  }

  async resize(size: { cols: number; rows: number }): Promise<void> {
    this._sendControl({ type: "resize", ...size });
  }

  /** Deliver accepted input, then close stdin. Piped processes only. */
  async closeStdin(): Promise<void> {
    if (this._stdinClosed) {
      await this._stdinTail;
      return;
    }
    this._stdinClosed = true;
    await this._queueStdin(() => this._sendControl({ type: "close_stdin" }));
  }

  /** Close this client connection without terminating the process. */
  async disconnect(): Promise<void> {
    const socket = this._socket;
    const closed = this._connectionClosed;
    if (!socket) return;

    this._socket = undefined;
    socket.close();
    await closed;
  }

  async wait(): Promise<SandboxProcessResult> {
    if (this._result) return this._result;
    const closed = this._connectionClosed;
    if (!closed) throw new Error("Process is disconnected");
    await Promise.race([this._terminal, closed]);
    if (!this._result) throw new Error("Process connection closed before exit");
    return this._result;
  }

  async kill(): Promise<SandboxProcessResult> {
    if (this._result) return this._result;
    this._sendControl({ type: "kill" });
    return this.wait();
  }

  /** @internal */
  async _connect(request: ProcessConnectionRequest): Promise<void> {
    const url = await this._connectionUrl();
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this._socket = socket;

    let resolveClosed!: () => void;
    this._connectionClosed = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => {
        readySettled = true;
        resolve();
      };
      rejectReady = (error) => {
        readySettled = true;
        reject(error);
      };
    });
    const expectedReady = request.type === "start" ? "started" : "attached";
    const fail = (error: unknown) => {
      if (!readySettled) {
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
    };

    socket.addEventListener("message", (message) => {
      try {
        this._handleMessage(message.data, expectedReady, resolveReady);
      } catch (error) {
        fail(error);
        socket.close();
      }
    });
    socket.addEventListener(
      "open",
      () => socket.send(JSON.stringify(request)),
      { once: true },
    );
    socket.addEventListener("error", () => {
      const error = new Error("Process connection failed");
      this._rejectPendingInput(error);
      fail(error);
    });
    socket.addEventListener(
      "close",
      () => {
        if (this._socket === socket) this._socket = undefined;
        if (!readySettled) {
          rejectReady(new Error("Process connection closed before ready"));
        }
        this._rejectPendingInput(
          new Error("Process connection closed before accepting input"),
        );
        resolveClosed();
      },
      { once: true },
    );

    await ready;
  }

  private _openSocket(): WebSocket {
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
      throw new Error("Process is disconnected");
    }
    return this._socket;
  }

  private _sendControl(message: Record<string, unknown>): void {
    this._openSocket().send(JSON.stringify(message));
  }

  private _queueStdin(operation: () => Promise<void> | void): Promise<void> {
    const result = this._stdinTail.then(operation);
    this._stdinTail = result.catch(() => {});
    return result;
  }

  private async _sendInput(data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.byteLength; offset += PROCESS_STDIN_CHUNK_BYTES) {
      const chunk = new Uint8Array(
        Math.min(PROCESS_STDIN_CHUNK_BYTES, data.byteLength - offset),
      );
      chunk.set(data.subarray(offset, offset + chunk.byteLength));
      while (!(await this._sendInputChunk(chunk))) {
        await new Promise((resolve) =>
          setTimeout(resolve, PROCESS_STDIN_RETRY_DELAY_MS),
        );
      }
    }
  }

  private _sendInputChunk(data: Uint8Array<ArrayBuffer>): Promise<boolean> {
    const socket = this._openSocket();
    return new Promise((resolve, reject) => {
      this._pendingInput = { resolve, reject };
      try {
        socket.send(data);
      } catch (error) {
        this._pendingInput = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private _handleMessage(
    data: string | ArrayBuffer,
    expectedReady: "started" | "attached",
    ready: () => void,
  ): void {
    if (typeof data !== "string") {
      this._handleOutput(data);
      return;
    }

    const event = JSON.parse(data) as ProcessControlEvent;
    switch (event.type) {
      case "started":
      case "attached":
        if (event.type !== expectedReady) {
          throw new Error(`Expected ${expectedReady}, received ${event.type}`);
        }
        if (this._id && this._id !== event.process_id) {
          throw new Error("Runtime returned a different process ID");
        }
        this._id = event.process_id;
        ready();
        return;
      case "input_accepted":
      case "input_backpressure": {
        const pending = this._pendingInput;
        this._pendingInput = undefined;
        pending?.resolve(event.type === "input_accepted");
        return;
      }
      case "input_closed":
        this._rejectPendingInput(new Error("Process stdin is closed"));
        return;
      case "exit":
        this._finish(event);
        return;
      case "error": {
        const error = new Error(`${event.error}: ${event.message}`);
        this._rejectPendingInput(error);
        throw error;
      }
    }
  }

  private _rejectPendingInput(error: Error): void {
    const pending = this._pendingInput;
    this._pendingInput = undefined;
    pending?.reject(error);
  }

  private _handleOutput(data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength < 9 || (bytes[0] !== 1 && bytes[0] !== 2)) {
      throw new Error("Invalid process output frame");
    }

    const offset = Number(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
        1,
      ),
    );
    const payload = bytes.subarray(9);
    const end = offset + payload.byteLength;
    if (end <= this._cursor) return;

    if (offset > this._cursor) {
      this._flushDecoders();
      this._cursor = offset;
    }

    const skip = Math.max(0, this._cursor - offset);
    const unread = payload.subarray(skip);
    const unreadOffset = offset + skip;
    this._cursor = end;
    const stream = bytes[0] === 1 ? "stdout" : "stderr";
    this._appendText(
      stream,
      (stream === "stdout" ? this._stdoutDecoder : this._stderrDecoder).decode(unread, {
        stream: true,
      }),
    );
    this._onOutput?.({ stream, offset: unreadOffset, data: unread });
  }

  private _appendText(stream: SandboxProcessStream, data: string): void {
    if (stream === "stdout") this.stdout += data;
    else this.stderr += data;
  }

  private _flushDecoders(): void {
    this._appendText("stdout", this._stdoutDecoder.decode());
    this._appendText("stderr", this._stderrDecoder.decode());
  }

  private _finish(event: Extract<ProcessControlEvent, { type: "exit" }>): void {
    if (this._result) return;
    this._flushDecoders();
    this._cursor = Math.max(this._cursor, event.cursor);
    this.status = event.status;
    this._result = {
      status: event.status,
      exitCode: event.exit_code ?? undefined,
      exitReason: event.exit_reason ?? undefined,
      stdout: this.stdout,
      stderr: this.stderr,
    };
    this._resolveTerminal(this._result);
  }
}
