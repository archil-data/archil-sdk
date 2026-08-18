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
  /** Retain decoded stdout and stderr on the handle and result. Defaults to true. */
  collectOutput?: boolean;
}

export interface SandboxProcessStartOptions {
  /** Enables a PTY. PTY output is merged into stdout and stderr remains empty. */
  terminal?: boolean | SandboxTerminalOptions;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  onOutput?: SandboxProcessOutputHandler;
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
      terminal?: boolean | { cols: number; rows: number };
      env: Record<string, string>;
      timeout_seconds?: number;
    }
  | { type: "attach"; process_id: string; offset: number };

type ProcessControlRequest =
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

const PROCESS_STDIN_CHUNK_BYTES = 1024 * 1024;

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
    const process = new SandboxProcess(
      "",
      0,
      options.onOutput,
      options.collectOutput ?? true,
      () => this._connectionUrl(),
      (request) => this._control(request),
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
    const process = new SandboxProcess(
      processId,
      offset,
      options.onOutput,
      options.collectOutput ?? true,
      () => this._connectionUrl(),
      (request) => this._control(request),
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
    return data.url;
  }

  private async _control(request: ProcessControlRequest): Promise<void> {
    const socket = new WebSocket(await this._connectionUrl());
    const expected = request.type === "kill" ? "killed" : "resized";
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener(
        "open",
        () => socket.send(JSON.stringify(request)),
        { once: true },
      );
      socket.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data as string) as
            | { type: "killed" | "resized" }
            | { type: "error"; error: string; message: string };
          if (event.type === "error") {
            reject(new Error(`${event.error}: ${event.message}`));
          } else if (event.type !== expected) {
            reject(new Error(`Expected ${expected}, received ${event.type}`));
          } else {
            resolve();
          }
        } catch (error) {
          reject(error);
        } finally {
          socket.close();
        }
      }, { once: true });
      socket.addEventListener("error", () =>
        reject(new Error(`Process ${request.type} request failed`)),
      );
      socket.addEventListener("close", () =>
        reject(
          new Error(
            `Process ${request.type} connection closed before confirmation`,
          ),
        ),
      );
    });
  }
}

export class SandboxProcess {
  status: SandboxProcessStatus = "running";
  stdout = "";
  stderr = "";

  private _id: string;
  private _cursor: number;
  private readonly _onOutput?: SandboxProcessOutputHandler;
  private readonly _collectOutput: boolean;
  private readonly _connectionUrl: () => Promise<string>;
  private readonly _controlProcess: (
    request: ProcessControlRequest,
  ) => Promise<void>;
  private readonly _stdoutDecoder = new TextDecoder();
  private readonly _stderrDecoder = new TextDecoder();
  private readonly _terminal: Promise<SandboxProcessResult>;
  private _resolveTerminal!: (result: SandboxProcessResult) => void;
  private _result?: SandboxProcessResult;
  private _socket?: WebSocket;
  private _connectionClosed?: Promise<void>;
  private _connectionError?: Error;
  private _stdinClosed = false;

  /** @internal */
  constructor(
    processId: string,
    cursor: number,
    onOutput: SandboxProcessOutputHandler | undefined,
    collectOutput: boolean,
    connectionUrl: () => Promise<string>,
    controlProcess: (request: ProcessControlRequest) => Promise<void>,
  ) {
    this._id = processId;
    this._cursor = cursor;
    this._onOutput = onOutput;
    this._collectOutput = collectOutput;
    this._connectionUrl = connectionUrl;
    this._controlProcess = controlProcess;
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

  async sendInput(data: string | Uint8Array): Promise<void> {
    if (this._stdinClosed) {
      throw new Error("Process stdin is closed");
    }
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data);
    this._sendInput(bytes);
  }

  async resize(size: { cols: number; rows: number }): Promise<void> {
    if (this.status !== "running") throw new Error("Process has exited");
    await this._controlProcess({
      type: "resize",
      process_id: this._id,
      ...size,
    });
  }

  /** Close stdin. Piped processes only. */
  async closeStdin(): Promise<void> {
    if (this._stdinClosed) return;
    this._sendControl({ type: "close_stdin" });
    this._stdinClosed = true;
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
    if (this._result) return this._result;
    if (this._connectionError) throw this._connectionError;
    throw new Error("Process connection closed before exit");
  }

  async kill(): Promise<void> {
    if (this._result) return;
    await this._controlProcess({ type: "kill", process_id: this._id });
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
      let output: SandboxProcessOutput | undefined;
      try {
        output = this._handleMessage(message.data, expectedReady, resolveReady);
      } catch (error) {
        const connectionError =
          error instanceof Error ? error : new Error(String(error));
        this._connectionError = connectionError;
        fail(connectionError);
        socket.close();
        return;
      }
      if (output) this._onOutput?.(output);
    });
    socket.addEventListener(
      "open",
      () => socket.send(JSON.stringify(request)),
      { once: true },
    );
    socket.addEventListener("error", () => {
      const error = new Error("Process connection failed");
      this._connectionError = error;
      fail(error);
    });
    socket.addEventListener(
      "close",
      () => {
        if (this._socket === socket) this._socket = undefined;
        if (!readySettled) {
          rejectReady(new Error("Process connection closed before ready"));
        }
        resolveClosed();
      },
      { once: true },
    );

    await ready;
  }

  private _openSocket(): WebSocket {
    if (this.status !== "running") {
      throw new Error("Process has exited");
    }
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
      throw new Error("Process is disconnected");
    }
    return this._socket;
  }

  private _sendControl(message: Record<string, unknown>): void {
    this._openSocket().send(JSON.stringify(message));
  }

  private _sendInput(data: Uint8Array): void {
    const socket = this._openSocket();
    for (let offset = 0; offset < data.byteLength; offset += PROCESS_STDIN_CHUNK_BYTES) {
      const chunk = new Uint8Array(
        Math.min(PROCESS_STDIN_CHUNK_BYTES, data.byteLength - offset),
      );
      chunk.set(data.subarray(offset, offset + chunk.byteLength));
      socket.send(chunk);
    }
  }

  private _handleMessage(
    data: string | ArrayBuffer,
    expectedReady: "started" | "attached",
    ready: () => void,
  ): SandboxProcessOutput | undefined {
    if (typeof data !== "string") {
      return this._handleOutput(data);
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
      case "exit":
        this._finish(event);
        return;
      case "error": {
        const error = new Error(`${event.error}: ${event.message}`);
        throw error;
      }
    }
  }

  private _handleOutput(data: ArrayBuffer): SandboxProcessOutput | undefined {
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
    if (this._collectOutput) {
      this._appendText(
        stream,
        (stream === "stdout" ? this._stdoutDecoder : this._stderrDecoder).decode(unread, {
          stream: true,
        }),
      );
    }
    return { stream, offset: unreadOffset, data: unread };
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

  private _finish(event: Extract<ProcessControlEvent, { type: "exit" }>): void {
    if (this._result) return;
    this.status = event.status;
    this._stdinClosed = true;
    this._flushDecoders();
    this._cursor = Math.max(this._cursor, event.cursor);
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
