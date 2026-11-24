import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ClientFrameSchema,
  Exit_Status,
  SandboxEgressPolicy_Action,
  ServerFrameSchema,
  type ClientFrame,
} from "@archildata/api-types/process";

/** The control plane's exec endpoint, as undici's WebSocket reaches it. */
const { ExecEndpoint } = vi.hoisted(() => {
  class ExecEndpoint extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: ExecEndpoint[] = [];
    /** Answers every exec with this error instead of starting it. */
    static refuse?: { code: string; message: string };
    readyState = 0;
    binaryType = "arraybuffer";
    bufferedAmount = 0;
    readonly protocol: string;
    readonly sent: ClientFrame[] = [];
    constructor(
      readonly url: URL,
      readonly init: { protocols: string[]; headers: Record<string, string> },
    ) {
      super();
      this.protocol = init.protocols[0] ?? "";
      ExecEndpoint.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(data: Uint8Array) {
      const frame = fromBinary(ClientFrameSchema, data);
      this.sent.push(frame);
      const id = frame.channelId;
      switch (frame.body.case) {
        case "exec": {
          const refuse = ExecEndpoint.refuse;
          queueMicrotask(() =>
            refuse
              ? this.emit(id, { case: "error", value: refuse })
              : this.emit(id, { case: "started", value: { processId: `exec_${id}` } }),
          );
          break;
        }
        case "stdin": {
          const input = frame.body.value;
          queueMicrotask(() => {
            this.emit(id, { case: "windowUpdate", value: { bytes: Math.max(input.length, 256) } });
            this.emit(id, { case: "stdout", value: { offset: 0n, data: input } });
          });
          break;
        }
        case "closeStdin":
          queueMicrotask(() =>
            this.emit(id, { case: "exit", value: { status: Exit_Status.COMPLETED, exitCode: 3 } }),
          );
          break;
        case "detach":
          queueMicrotask(() => this.emit(id, { case: "detached", value: {} }));
          break;
      }
    }
    emit(id: number, body: NonNullable<Parameters<typeof create<typeof ServerFrameSchema>>[1]>["body"]) {
      const data = toBinary(ServerFrameSchema, create(ServerFrameSchema, { channelId: id, body }));
      this.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  return { ExecEndpoint };
});

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  WebSocket: ExecEndpoint,
}));

const { Archil } = await import("../src/archil.js");

function archil() {
  // The channel code reads WebSocket's state constants from the global.
  vi.stubGlobal("WebSocket", ExecEndpoint);
  return new Archil({ apiKey: "key-secret", region: "aws-us-east-1", baseUrl: "https://control.example.com" });
}

afterEach(() => {
  for (const socket of ExecEndpoint.instances) socket.close();
  ExecEndpoint.instances = [];
  ExecEndpoint.refuse = undefined;
  vi.unstubAllGlobals();
});

test("a streamed exec opens a channel with the API key and exec's options, then streams input and output", async () => {
  const process = await archil().exec({
    stream: true,
    command: "cat",
    cwd: "/work",
    env: { A: "1" },
    timeoutSeconds: 60,
    disks: { data: { disk: "dsk-0123456789abcdef", readOnly: true }, "": "dsk-fedcba9876543210" },
    baseImage: "python:3.12",
    vcpuCount: 4,
    memSizeMib: 8192,
    network: {
      egress: {
        default: "deny",
        allow: ["pypi.org", { target: "api.example.com", transform: { headers: { "x-key": "v" } } }],
      },
    },
  });

  const socket = ExecEndpoint.instances[0];
  assert.equal(socket.url.toString(), "wss://control.example.com/api/exec/stream");
  assert.deepEqual(socket.init.protocols, ["archil.connect.v2"]);
  assert.equal(socket.init.headers.Authorization, "Bearer key-secret");
  const opening = socket.sent[0];
  assert.equal(opening.body.case, "exec");
  const exec = opening.body.case === "exec" ? opening.body.value : undefined;
  assert.equal(exec?.start?.command, "cat");
  assert.equal(exec?.start?.cwd, "/work");
  assert.deepEqual(exec?.start?.env, { A: "1" });
  assert.equal(exec?.start?.timeoutSeconds, 60n);
  assert.deepEqual(exec?.sandbox?.image, { case: "baseImage", value: "python:3.12" });
  assert.equal(exec?.sandbox?.vcpus, 4);
  assert.equal(exec?.sandbox?.memoryMib, 8192);
  // Each disk mounts where a waiting exec mounts it: under /mnt/archil at its key.
  assert.deepEqual(exec?.sandbox?.mounts.map((mount) => [mount.diskId, mount.path, mount.readOnly]), [
    ["dsk-0123456789abcdef", "/mnt/archil/data", true],
    ["dsk-fedcba9876543210", "/mnt/archil", false],
  ]);
  const egress = exec?.sandbox?.network?.egress;
  assert.equal(egress?.defaultAction, SandboxEgressPolicy_Action.DENY);
  assert.deepEqual(egress?.allow.map((rule) => [rule.target, rule.transform?.headers]), [
    ["pypi.org", undefined],
    ["api.example.com", { "x-key": "v" }],
  ]);

  await process.sendInput("hello");
  await process.closeStdin();
  const result = await process.wait();
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "hello");
});

test("concurrent streamed execs share a connection until it carries 32", async () => {
  const client = archil();
  await Promise.all(Array.from({ length: 33 }, () => client.exec({ stream: true, command: "true" })));
  assert.equal(ExecEndpoint.instances.length, 2);
  assert.equal(ExecEndpoint.instances[0].sent.filter((frame) => frame.body.case === "exec").length, 32);
  assert.equal(ExecEndpoint.instances[1].sent.filter((frame) => frame.body.case === "exec").length, 1);
});

test("kill stops an exec by detaching its channel", async () => {
  const process = await archil().exec({ stream: true, command: "sleep 600" });
  await process.kill();
  const socket = ExecEndpoint.instances[0];
  assert.equal(socket.sent.at(-1)?.body.case, "detach");
  await assert.rejects(process.wait(), /disconnected/);
});

test("an exec the endpoint refuses rejects with its error", async () => {
  ExecEndpoint.refuse = { code: "image_not_ready", message: "Image has no finished build yet" };
  await assert.rejects(
    archil().exec({ stream: true, command: "true", imageId: "img-1" }),
    /image_not_ready: Image has no finished build yet/,
  );
});

test("an exec's terminal cannot be resized, and conflicting images are refused before connecting", async () => {
  const client = archil();
  const process = await client.exec({ stream: true, command: "bash", terminal: true });
  await assert.rejects(process.resize({ cols: 100, rows: 40 }), /cannot be resized/);
  const connections = ExecEndpoint.instances.length;
  await assert.rejects(client.exec({ stream: true, command: "true", baseImage: "a", imageId: "b" }), /mutually exclusive/);
  assert.equal(ExecEndpoint.instances.length, connections);
});
