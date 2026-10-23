import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  EnvelopeSchema,
  Exit_Status,
  type Envelope,
} from "../src/generated/process_pb.js";
import { Sandbox, type SandboxWire } from "../src/sandbox.js";
import type { ApiClient } from "../src/client.js";

class RuntimeSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: RuntimeSocket[] = [];
  /** Open without selecting the requested subprotocol, as an older runtime would. */
  static ignoreProtocol = false;
  /** Return stdin credit as the guest would after reading it. */
  static grantStdin = true;
  readyState = 0;
  binaryType = "arraybuffer";
  readonly protocol: string;
  readonly sent: Envelope[] = [];
  constructor(
    readonly url: string,
    protocol?: string,
  ) {
    super();
    this.protocol = RuntimeSocket.ignoreProtocol ? "" : protocol ?? "";
    RuntimeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(data: Uint8Array) {
    const frame = fromBinary(EnvelopeSchema, data);
    this.sent.push(frame);
    const id = frame.channelId;
    switch (frame.body.case) {
      case "start":
      case "attach":
        queueMicrotask(() =>
          this.emit(id, {
            case: frame.body.case === "start" ? "started" : "attached",
            value: { processId: frame.body.case === "attach" ? frame.body.value.processId : `process_${id}` },
          }),
        );
        break;
      case "stdin":
        if (RuntimeSocket.grantStdin) {
          const bytes = Math.max(frame.body.value.length, 256);
          queueMicrotask(() => this.emit(id, { case: "windowUpdate", value: { bytes } }));
        }
        break;
      case "detach":
        queueMicrotask(() => this.emit(id, { case: "detached", value: {} }));
        break;
      case "kill":
        queueMicrotask(() => this.emit(id, { case: "killed", value: {} }));
        break;
      case "resize":
        queueMicrotask(() => this.emit(id, { case: "resized", value: {} }));
        break;
    }
  }
  emit(
    id: number,
    body: NonNullable<
      Parameters<typeof create<typeof EnvelopeSchema>>[1]
    >["body"],
  ) {
    const data = toBinary(
      EnvelopeSchema,
      create(EnvelopeSchema, { channelId: id, body }),
    );
    this.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
  }
  /** A message carrying a body type added after this SDK was built. */
  emitFuture(id: number) {
    const known = toBinary(EnvelopeSchema, create(EnvelopeSchema, { channelId: id }));
    // Field 1000, varint 1.
    const data = new Uint8Array([...known, 0xc0, 0x3e, 0x01]);
    this.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
  }
  exit(id: number) {
    this.emit(id, {
      case: "exit",
      value: { status: Exit_Status.COMPLETED, exitCode: 0 },
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
function setup() {
  vi.stubGlobal("WebSocket", RuntimeSocket);
  const post = vi.fn(async () => ({
    data: {
      success: true,
      data: { url: "ws://runtime/connect", expires_at: "2099-01-01" },
    },
    response: new Response(null, { status: 200 }),
  }));
  const sandbox = new Sandbox({ sandbox_id: "sandbox", mounts: [] } as unknown as SandboxWire, {
    POST: post,
  } as unknown as ApiClient);
  return { processes: sandbox.processes, sandbox, post };
}
afterEach(() => {
  for (const socket of RuntimeSocket.instances) socket.close();
  RuntimeSocket.instances = [];
  RuntimeSocket.ignoreProtocol = false;
  RuntimeSocket.grantStdin = true;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("concurrent and sequential processes reuse one authorized binary connection, which closes after five idle seconds", async () => {
  vi.useFakeTimers();
  const { processes, sandbox, post } = setup();
  const [first, second] = await Promise.all([
    sandbox.run("one", { cwd: "/workspace" }),
    processes.start("two"),
  ]);
  const socket = RuntimeSocket.instances[0];
  assert.equal(socket.sent[0].body.case === "start" && socket.sent[0].body.value.cwd, "/workspace");
  assert.equal(post.mock.calls.length, 1);
  assert.equal(RuntimeSocket.instances.length, 1);
  assert.deepEqual(
    socket.sent.map((f) => [f.channelId, f.body.case]),
    [
      [1, "start"],
      [2, "start"],
    ],
  );
  socket.emit(2, {
    case: "stdout",
    value: { data: new Uint8Array([0, 255, 65]), offset: 0n },
  });
  socket.exit(2);
  socket.exit(1);
  assert.equal((await first.wait()).exitCode, 0);
  assert.equal((await second.wait()).stdout, "\0�A");
  const third = await processes.start("three");
  socket.exit(3);
  await third.wait();
  assert.equal(post.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(4999);
  assert.equal(socket.readyState, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(socket.readyState, 3);
  const fourth = await processes.start("four");
  assert.equal(post.mock.calls.length, 2);
  RuntimeSocket.instances[1].exit(1);
  await fourth.wait();
  await processes.disconnect();
});

test("stdin chunks spend returned credit and precede EOF", async () => {
  const { processes } = setup();
  const process = await processes.start("cat");
  const socket = RuntimeSocket.instances[0];
  const sending = process.sendInput(new Uint8Array(2 * 1024 * 1024));
  const closing = process.closeStdin();
  await assert.rejects(process.sendInput("late"), /stdin is closed/);
  await Promise.all([sending, closing]);
  assert.deepEqual(socket.sent.map(frame => frame.body.case), ["start", ...Array(32).fill("stdin"), "closeStdin"]);
  socket.exit(1);
  await process.wait();
  await processes.disconnect();
});

test("stdin waits for credit while the process is not reading", async () => {
  RuntimeSocket.grantStdin = false;
  const { processes } = setup();
  const process = await processes.start("sleep");
  const socket = RuntimeSocket.instances[0];
  const stdin = () => socket.sent.filter(frame => frame.body.case === "stdin").length;
  let sent = false;
  const sending = process.sendInput(new Uint8Array(512 * 1024)).then(() => { sent = true; });
  await vi.waitFor(() => assert.equal(stdin(), 4));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stdin(), 4, "sent beyond the initial window");
  assert.equal(sent, false);
  socket.emit(1, { case: "windowUpdate", value: { bytes: 256 * 1024 } });
  await sending;
  assert.equal(stdin(), 8);
  socket.exit(1);
  await process.wait();
  await processes.disconnect();
});

test("detach, resize, and kill do not close another channel or reopen the socket", async () => {
  const { processes, post } = setup();
  const [first, second] = await Promise.all([
    processes.start("one"),
    processes.start("two"),
  ]);
  await first.resize({ rows: 40, cols: 100 });
  await first.kill();
  await first.disconnect();
  assert.equal(first.connected, false);
  assert.equal(second.connected, true);
  RuntimeSocket.instances[0].exit(2);
  await second.wait();
  assert.equal(post.mock.calls.length, 1);
  await processes.disconnect();
});

test("messages from a newer runtime are ignored without disturbing the connection", async () => {
  const { processes } = setup();
  const [first, second] = await Promise.all([processes.start("one"), processes.start("two")]);
  const socket = RuntimeSocket.instances[0];
  socket.emitFuture(0);
  socket.emitFuture(1);
  socket.emit(1, { case: "stdout", value: { offset: 0n, data: new TextEncoder().encode("ok") } });
  socket.exit(1);
  socket.exit(2);
  assert.equal((await first.wait()).stdout, "ok");
  await second.wait();
  assert.equal(socket.readyState, RuntimeSocket.OPEN);
  await processes.disconnect();
});

test("an exit status from a newer runtime fails only its own process", async () => {
  const { processes } = setup();
  const [first, second] = await Promise.all([processes.start("one"), processes.start("two")]);
  const socket = RuntimeSocket.instances[0];
  socket.emit(1, { case: "exit", value: { status: 99 as Exit_Status, exitCode: 0 } });
  await assert.rejects(first.wait(), /unsupported_exit_status/);
  socket.exit(2);
  assert.equal((await second.wait()).exitCode, 0);
  assert.equal(socket.readyState, RuntimeSocket.OPEN);
  await processes.disconnect();
});

test("a runtime without the binary protocol fails before any command is sent", async () => {
  RuntimeSocket.ignoreProtocol = true;
  const { processes, post } = setup();
  await assert.rejects(processes.start("once"), /does not support the archil-process-v2 process protocol/);
  assert.equal(RuntimeSocket.instances[0].sent.length, 0);
  assert.equal(RuntimeSocket.instances[0].readyState, RuntimeSocket.CLOSED);
  assert.equal(post.mock.calls.length, 1, "an unsupported runtime is not retried");
});

test("transport loss surfaces an uncertain START without replaying it", async () => {
  const { processes, post } = setup();
  const process = await processes.start("once");
  const socket = RuntimeSocket.instances[0];
  socket.close();
  await assert.rejects(process.wait(), /connection_closed/);
  assert.equal(post.mock.calls.length, 1);
  assert.equal(
    socket.sent.filter((frame) => frame.body.case === "start").length,
    1,
  );
  await processes.disconnect();
});

test("a draining socket finishes existing channels while new work gets a fresh connection", async () => {
  const { processes, post } = setup();
  const first = await processes.start("long-running");
  const old = RuntimeSocket.instances[0];
  old.emit(0, { case: "drain", value: {} });
  const second = await processes.start("new-work");
  assert.equal(post.mock.calls.length, 2);
  assert.equal(first.connected, true);
  RuntimeSocket.instances[1].exit(1);
  await second.wait();
  old.exit(1);
  await first.wait();
  assert.equal(old.readyState, 3);
  await processes.disconnect();
});

test("output is paced by credit and never detached, however many channels buffer", async () => {
  const { processes } = setup();
  // Each channel buffers a full window without pausing any other.
  const started = await Promise.all(Array.from({ length: 17 }, (_, n) => processes.start(`p${n}`, { collectOutput: false })));
  const socket = RuntimeSocket.instances[0];
  const chunk = new Uint8Array(64 * 1024);
  for (let id = 1; id <= started.length; id++)
    for (let n = 0; n < 4; n++) socket.emit(id, { case: "stdout", value: { offset: BigInt(n * chunk.length), data: chunk } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(socket.sent.filter(f => f.body.case === "detach" || f.body.case === "attach").length, 0);
  for (const process of started) assert.equal(process.cursor, 4 * chunk.length);
  const granted = () => socket.sent.filter(f => f.channelId === 1 && f.body.case === "windowUpdate")
    .reduce((sum, f) => sum + (f.body.case === "windowUpdate" ? f.body.value.bytes : 0), 0);
  assert.equal(granted(), 0, "credit returned before the application consumed output");
  const output = started[0].output[Symbol.asyncIterator]();
  await output.next();
  assert.equal(granted(), 0, "credit is batched");
  await output.next();
  assert.equal(granted(), 128 * 1024);
  await output.next();
  await output.next();
  assert.equal(granted(), 256 * 1024);
  socket.exit(1);
  assert.equal((await output.next()).done, true);
  await processes.disconnect();
});

test("output beyond the granted window closes the connection", async () => {
  const { processes } = setup();
  const process = await processes.start("noisy", { collectOutput: false });
  const socket = RuntimeSocket.instances[0];
  const chunk = new Uint8Array(64 * 1024);
  for (let n = 0; n < 5; n++) socket.emit(1, { case: "stdout", value: { offset: BigInt(n * chunk.length), data: chunk } });
  await assert.rejects(process.wait(), /connection_closed/);
  assert.equal(socket.readyState, RuntimeSocket.CLOSED);
});

test("iterator yields binary chunks and ends after draining output before wait resolves", async () => {
  const { processes } = setup();
  const process = await processes.start("one", { collectOutput: false });
  const socket = RuntimeSocket.instances[0];
  const iterator = process.output[Symbol.asyncIterator]();
  socket.emit(1, { case: "stdout", value: { offset: 0n, data: new Uint8Array([0, 255]) } });
  socket.exit(1);
  const next = await iterator.next();
  assert.deepEqual(next.value?.data, new Uint8Array([0, 255]));
  assert.equal((await iterator.next()).done, true);
  assert.equal((await process.wait()).stdout, "");
  await processes.disconnect();
});
