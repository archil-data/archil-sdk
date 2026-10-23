import { MAX_RETRIES, retrySleep } from "./retry.js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  EnvelopeSchema,
  Exit_Status,
  type Envelope,
} from "./generated/process_pb.js";

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", closed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Process connection failed"));
    };
    const closed = () => {
      cleanup();
      reject(new Error("Process connection closed before opening"));
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", closed, { once: true });
  });
}

export async function openProcessSocket(
  connectionUrl: () => Promise<string>,
): Promise<WebSocket> {
  for (let attempt = 0; ; attempt++) {
    const url = await connectionUrl();
    let socket: WebSocket | undefined;
    try {
      socket = new WebSocket(url);
      await waitForSocketOpen(socket);
      return socket;
    } catch (error) {
      try {
        socket?.close();
      } catch {}
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `Process connection failed after ${attempt + 1} attempts`,
          { cause: error },
        );
      }
    }
    await retrySleep(attempt);
  }
}

/** Bound queued socket writes; logical input queue overflow is still an error. */
export async function waitForProcessWrite(socket: WebSocket): Promise<void> {
  while (socket.bufferedAmount > 256 * 1024) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Process is disconnected");
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

const PROTOCOL = "archil-process-v2";
const MAX_DATA = 64 * 1024;
const MAX_CHANNELS = 128;
const IDLE_MS = 5000;

type Request =
  | {
      type: "start";
      command: string;
      cwd?: string;
      env: Record<string, string>;
      terminal?: boolean | { rows: number; cols: number };
      timeout_seconds?: number;
    }
  | { type: "attach"; process_id: string; offset: number }
  | { type: "kill"; process_id: string }
  | { type: "resize"; process_id: string; rows: number; cols: number };
export type ProcessSocket = WebSocket | BinaryChannel;

/** Owns only the client connection. A disconnected transport never retries START. */
export class ProcessConnection {
  private opening?: Promise<BinaryConnection | WebSocket>;
  private binary?: BinaryConnection;
  private legacy = false;
  private readonly sockets = new Set<WebSocket>();
  private generation = 0;
  constructor(private readonly url: () => Promise<string>) {}

  async open(): Promise<ProcessSocket> {
    if (this.binary?.canOpen) return this.binary.channel();
    if (this.legacy) return this.legacyConnection();
    if (!this.opening) {
      const opening = this.negotiate().finally(() => {
        if (this.opening === opening) this.opening = undefined;
      });
      this.opening = opening;
    }
    const connection = await this.opening;
    if (connection instanceof BinaryConnection) return connection.channel();
    // A legacy socket belongs to one operation. Concurrent callers each get one.
    if (this.legacySocket === connection) {
      this.legacySocket = undefined;
      return connection;
    }
    return this.legacyConnection();
  }
  private legacySocket?: WebSocket;

  private async negotiate(): Promise<BinaryConnection | WebSocket> {
    const generation = this.generation;
    const url = await this.url();
    if (generation !== this.generation)
      throw new Error("Process connection opening cancelled");
    const socket = this.socket(url, PROTOCOL);
    socket.binaryType = "arraybuffer";
    const selected = await new Promise<boolean>((resolve) => {
      socket.addEventListener(
        "open",
        () => resolve(socket.protocol === PROTOCOL),
        { once: true },
      );
      socket.addEventListener("error", () => resolve(false), { once: true });
      socket.addEventListener("close", () => resolve(false), { once: true });
    });
    if (generation !== this.generation)
      throw new Error("Process connection opening cancelled");
    if (!selected) {
      this.legacy = true;
      // Some WebSocket implementations accept an omitted subprotocol; others
      // reject the handshake. Both paths precede any application command.
      if (socket.readyState === WebSocket.OPEN) {
        this.legacySocket = socket;
        return socket;
      }
      socket.close();
      const legacy = await this.legacyConnection();
      this.legacySocket = legacy;
      return legacy;
    }
    const binary = new BinaryConnection(socket);
    if (generation !== this.generation) {
      binary.close();
      throw new Error("Process connection opening cancelled");
    }
    this.binary = binary;
    return binary;
  }
  private async legacyConnection(): Promise<WebSocket> {
    const socket = await openProcessSocket(this.url);
    this.sockets.add(socket);
    socket.addEventListener("close", () => this.sockets.delete(socket), { once: true });
    return socket;
  }
  private socket(url: string, protocol?: string): WebSocket {
    const socket = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
    this.sockets.add(socket);
    socket.addEventListener("close", () => this.sockets.delete(socket), {
      once: true,
    });
    return socket;
  }

  disconnect(): void {
    this.generation++;
    this.opening = undefined;
    this.binary?.close();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.binary = undefined;
    // Re-negotiate after host movement or a runtime upgrade.
    this.legacy = false;
  }
}

class BinaryConnection {
  readonly channels = new Map<number, BinaryChannel>();
  private next = 1;
  private draining = false;
  private idle?: ReturnType<typeof setTimeout>;
  get canOpen(): boolean {
    return !this.draining && this.socket.readyState === WebSocket.OPEN &&
      this.next < 0xffffffff && this.channels.size < MAX_CHANNELS;
  }
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (message) => {
      try {
        const frame = fromBinary(EnvelopeSchema, new Uint8Array(message.data as ArrayBuffer));
        if (frame.channelId === 0) {
          if (frame.body.case !== "drain") throw new Error("Unexpected process connection message");
          this.draining = true;
          if (!this.channels.size) this.close();
        } else this.channels.get(frame.channelId)?.receive(frame);
      } catch (error) { this.close(error); }
    });
    socket.addEventListener("close", () => this.close(new Error("Process connection closed before exit")), { once: true });
    socket.addEventListener("error", () => this.close(new Error("Process connection failed")), { once: true });
  }
  channel(): BinaryChannel {
    if (!this.canOpen) throw new Error("Process connection is draining or full");
    clearTimeout(this.idle);
    const channel = new BinaryChannel(this, this.next++);
    this.channels.set(channel.id, channel);
    return channel;
  }
  send(id: number, body: Envelope["body"]): void {
    this.socket.send(
      toBinary(EnvelopeSchema, create(EnvelopeSchema, { channelId: id, body })),
    );
  }
  async writable(): Promise<void> { await waitForProcessWrite(this.socket); }
  remove(id: number): void {
    this.channels.delete(id);
    if (!this.channels.size) {
      if (this.draining) this.close();
      else this.idle = setTimeout(() => this.close(), IDLE_MS);
    }
  }
  close(reason?: unknown): void {
    this.draining = true;
    clearTimeout(this.idle);
    for (const channel of [...this.channels.values()]) channel.finish(reason);
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

/** @internal WebSocket-shaped channel; generated protobuf owns all wire encoding. */
export class BinaryChannel {
  readyState: number = WebSocket.OPEN;
  binaryType = "arraybuffer";
  private readonly events = new EventTarget();
  readonly addEventListener = this.events.addEventListener.bind(
    this.events,
  ) as WebSocket["addEventListener"];
  private sending: Promise<void> = Promise.resolve();
  constructor(
    private readonly connection: BinaryConnection,
    readonly id: number,
  ) {}
  sendRequest(request: Request): void {
    switch (request.type) {
      case "start": {
        const terminal =
          request.terminal === true
            ? { rows: 24, cols: 80 }
            : request.terminal || undefined;
        this.connection.send(
          this.id,
          create(EnvelopeSchema, {
            body: {
              case: "start",
              value: {
                command: request.command,
                cwd: request.cwd,
                terminal,
                env: request.env,
                timeoutSeconds:
                  request.timeout_seconds === undefined
                    ? undefined
                    : BigInt(request.timeout_seconds),
              },
            },
          }).body,
        );
        break;
      }
      case "attach":
        this.connection.send(
          this.id,
          create(EnvelopeSchema, {
            body: {
              case: "attach",
              value: {
                processId: request.process_id,
                offset: BigInt(request.offset),
              },
            },
          }).body,
        );
        break;
      case "kill":
        this.connection.send(
          this.id,
          create(EnvelopeSchema, {
            body: { case: "kill", value: { processId: request.process_id } },
          }).body,
        );
        break;
      case "resize":
        this.connection.send(
          this.id,
          create(EnvelopeSchema, {
            body: {
              case: "resize",
              value: {
                processId: request.process_id,
                terminal: { rows: request.rows, cols: request.cols },
              },
            },
          }).body,
        );
        break;
    }
  }
  send(bytes: Uint8Array): Promise<void> {
    const sending = this.sending.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += MAX_DATA) {
        if (this.readyState !== WebSocket.OPEN) throw new Error("Process is disconnected");
        this.connection.send(this.id, { case: "stdin", value: bytes.subarray(offset, offset + MAX_DATA) });
        await this.connection.writable();
      }
    });
    this.sending = sending.catch(() => {});
    return sending;
  }
  async closeStdin(): Promise<void> {
    await this.sending;
    if (this.readyState !== WebSocket.OPEN)
      throw new Error("Process is disconnected");
    this.connection.send(
      this.id,
      create(EnvelopeSchema, { body: { case: "closeStdin", value: {} } }).body,
    );
  }
  close(): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSING;
    this.connection.send(
      this.id,
      create(EnvelopeSchema, { body: { case: "detach", value: {} } }).body,
    );
  }
  receive(frame: Envelope): void {
    const body = frame.body;
    let event: unknown;
    switch (body.case) {
      case "started":
      case "attached":
        event = { type: body.case, process_id: body.value.processId };
        break;
      case "stdout":
      case "stderr": {
        if (body.value.data.length > MAX_DATA) throw new Error("Process output exceeds chunk size");
        const offset = Number(body.value.offset);
        if (!Number.isSafeInteger(offset))
          throw new Error(
            "Process offset exceeds JavaScript integer precision",
          );
        this.events.dispatchEvent(
          new MessageEvent("message", {
            data: { stream: body.case, offset, data: body.value.data },
          }),
        );
        return;
      }
      case "exit": {
        const statuses = {
          [Exit_Status.COMPLETED]: "completed",
          [Exit_Status.FAILED]: "failed",
          [Exit_Status.CANCELLED]: "cancelled",
          [Exit_Status.TIMED_OUT]: "timed_out",
        };
        const status = statuses[body.value.status as keyof typeof statuses];
        if (!status) throw new Error("Unknown process exit status");
        event = {
          type: "exit",
          status,
          exit_code: body.value.exitCode,
          exit_reason: body.value.exitReason,
          cursor: Number(body.value.cursor),
        };
        break;
      }
      case "error":
        event = {
          type: "error",
          error: body.value.code,
          message: body.value.message,
        };
        break;
      case "killed":
      case "resized":
        event = { type: body.case };
        break;
      case "detached":
        this.finish();
        return;
      default:
        throw new Error("Unexpected process channel message");
    }
    this.events.dispatchEvent(new MessageEvent("message", { data: event }));
    if (["exit", "error", "killed", "resized"].includes(body.case!))
      this.finish();
  }
  finish(reason?: unknown): void {
    if (this.readyState === WebSocket.CLOSED) return;
    if (reason)
      this.events.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "error",
            error: "connection_closed",
            message: String(reason),
          },
        }),
      );
    this.readyState = WebSocket.CLOSED;
    this.connection.remove(this.id);
    this.events.dispatchEvent(new Event("close"));
  }
}
