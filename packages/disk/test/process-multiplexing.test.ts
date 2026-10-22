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
  static window = 256 * 1024;
  static rejectProtocol = false;
  readyState = 0;
  binaryType = "arraybuffer";
  readonly protocol: string;
  readonly sent: Envelope[] = [];
  readonly texts: string[] = [];
  constructor(
    readonly url: string,
    protocol?: string,
  ) {
    super();
    this.protocol = protocol ?? "";
    RuntimeSocket.instances.push(this);
    queueMicrotask(() => {
      if (protocol && RuntimeSocket.rejectProtocol) {
        this.dispatchEvent(new Event("error"));
        this.close();
      } else {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
    });
  }
  send(data: Uint8Array | string) {
    if (typeof data === "string") {
      this.texts.push(data);
      const request = JSON.parse(data);
      if (request.type === "start")
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "started", process_id: "legacy" }),
            }),
          ),
        );
      return;
    }
    const frame = fromBinary(EnvelopeSchema, data);
    this.sent.push(frame);
    const id = frame.channelId;
    switch (frame.body.case) {
      case "settings":
        queueMicrotask(() =>
          this.emit(0, {
            case: "settings",
            value: {
              receiveWindow: RuntimeSocket.window,
              maxDataBytes: 65536,
              maxChannels: 128,
            },
          }),
        );
        break;
      case "start":
      case "attach":
        queueMicrotask(() =>
          this.emit(id, {
            case: frame.body.case === "start" ? "started" : "attached",
            value: { processId: `process_${id}` },
          }),
        );
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
  RuntimeSocket.window = 256 * 1024;
  RuntimeSocket.rejectProtocol = false;
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
  assert.equal(socket.sent[1].body.case === "start" && socket.sent[1].body.value.cwd, "/workspace");
  assert.equal(post.mock.calls.length, 1);
  assert.equal(RuntimeSocket.instances.length, 1);
  assert.deepEqual(
    socket.sent.map((f) => [f.channelId, f.body.case]),
    [
      [0, "settings"],
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

test("stdin credit stalls only its channel and EOF follows accepted input", async () => {
  RuntimeSocket.window = 65536 + 64;
  const { processes } = setup();
  const slow = await processes.start("cat");
  const socket = RuntimeSocket.instances[0];
  const sending = slow.sendInput(new Uint8Array(2 * 1024 * 1024));
  const closing = slow.closeStdin();
  await assert.rejects(slow.sendInput("late"), /stdin is closed/);
  const fast = await processes.start("fast");
  socket.exit(2);
  assert.equal((await fast.wait()).exitCode, 0);
  assert.equal(socket.sent.filter((f) => f.body.case === "stdin").length, 1);
  assert.equal(
    socket.sent.filter((f) => f.body.case === "closeStdin").length,
    0,
  );
  for (let n = 1; n < 32; n++) {
    socket.emit(1, { case: "windowUpdate", value: { credit: 65536 + 64 } });
    await Promise.resolve();
  }
  await sending;
  await closing;
  assert.deepEqual(
    socket.sent.filter((f) => f.channelId === 1).map((f) => f.body.case),
    ["start", ...Array(32).fill("stdin"), "closeStdin"],
  );
  socket.exit(1);
  await slow.wait();
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

test("unsupported subprotocol falls back before any command is sent", async () => {
  RuntimeSocket.rejectProtocol = true;
  const { processes } = setup();
  const process = await processes.start("once");
  assert.equal(process.id, "legacy");
  assert.equal(RuntimeSocket.instances[0].sent.length, 0);
  assert.equal(RuntimeSocket.instances[0].texts.length, 0);
  assert.equal(RuntimeSocket.instances[1].texts.length, 1);
  await process.disconnect();
  await processes.disconnect();
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
