import assert from "node:assert/strict";
import { test } from "vitest";
import { SandboxFileTransferError } from "../src/errors.js";
import {
  SandboxFiles,
  sandboxFileCommands,
} from "../src/sandbox-files.js";
import type {
  SandboxProcess,
  SandboxProcessOutputHandler,
  SandboxProcessResult,
  SandboxProcessStartOptions,
  SandboxProcesses,
} from "../src/sandbox-process.js";

const completed: SandboxProcessResult = {
  status: "completed",
  exitCode: 0,
  stdout: "",
  stderr: "",
};

class FakeProcess {
  readonly input: Array<string | Uint8Array> = [];
  readonly env: Record<string, string>;
  readonly collectOutput: boolean;
  killed = false;
  disconnected = false;

  private readonly _command: string;
  private readonly _content: Uint8Array;
  private readonly _onOutput?: SandboxProcessOutputHandler;
  private readonly _gap: boolean;
  private _cursor = 0;
  private _position = 0;
  private _resolve!: (result: SandboxProcessResult) => void;
  private readonly _result = new Promise<SandboxProcessResult>((resolve) => {
    this._resolve = resolve;
  });

  constructor(
    command: string,
    options: SandboxProcessStartOptions,
    content: Uint8Array,
    gap: boolean,
  ) {
    this._command = command;
    this.env = options.env ?? {};
    this.collectOutput = options.collectOutput ?? true;
    this._content = content;
    this._onOutput = options.onOutput;
    this._gap = gap;
  }

  async sendInput(data: string | Uint8Array): Promise<void> {
    this.input.push(data);
    if (this._command !== sandboxFileCommands.download) return;

    const count = Number(data);
    const chunk = this._content.slice(this._position, this._position + count);
    const size = new TextEncoder().encode(`${chunk.byteLength}\n`);
    this._onOutput?.({
      stream: "stdout",
      offset: this._gap ? this._cursor + 1 : this._cursor,
      data: size,
    });
    this._cursor += size.byteLength;
    const midpoint = Math.max(1, Math.floor(chunk.byteLength / 2));
    for (const part of [chunk.slice(0, midpoint), chunk.slice(midpoint)]) {
      if (part.byteLength === 0) continue;
      this._onOutput?.({ stream: "stdout", offset: this._cursor, data: part });
      this._cursor += part.byteLength;
    }
    this._position += chunk.byteLength;
    if (chunk.byteLength < count) this._resolve(completed);
  }

  async closeStdin(): Promise<void> {
    this._resolve(completed);
  }

  wait(): Promise<SandboxProcessResult> {
    return this._result;
  }

  async kill(): Promise<SandboxProcessResult> {
    this.killed = true;
    const result: SandboxProcessResult = {
      status: "cancelled",
      exitReason: "process killed",
      stdout: "",
      stderr: "",
    };
    this._resolve(result);
    return result;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeProcesses {
  readonly started: FakeProcess[] = [];

  constructor(
    private readonly _content = new Uint8Array(),
    private readonly _gap = false,
  ) {}

  async start(
    command: string,
    options: SandboxProcessStartOptions = {},
  ): Promise<SandboxProcess> {
    const process = new FakeProcess(command, options, this._content, this._gap);
    this.started.push(process);
    return process as unknown as SandboxProcess;
  }
}

function files(processes: FakeProcesses): SandboxFiles {
  return new SandboxFiles(processes as unknown as SandboxProcesses);
}

test("uploadFile streams source chunks through the process API", async () => {
  const processes = new FakeProcesses();
  async function* source() {
    yield new Uint8Array([0, 1, 2]);
    yield new Uint8Array([253, 254, 255]);
  }

  await files(processes).uploadFile(source(), "/workspace/source.bin", {
    mode: 0o640,
  });

  const process = processes.started[0];
  assert.deepEqual(process.input, [
    new Uint8Array([0, 1, 2]),
    new Uint8Array([253, 254, 255]),
  ]);
  assert.equal(process.env.ARCHIL_FILE_TARGET, "/workspace/source.bin");
  assert.equal(process.env.ARCHIL_FILE_PARENT, "/workspace");
  assert.equal(process.env.ARCHIL_FILE_MODE, "640");
  assert.equal(process.disconnected, true);
});

test("downloadFile requests bounded ranges and writes binary chunks", async () => {
  const content = new Uint8Array(512 * 1024 + 3);
  content.set([0, 255, 1], content.byteLength - 3);
  const processes = new FakeProcesses(content);
  const chunks: Uint8Array[] = [];

  await files(processes).downloadFile("/workspace/result.bin", (chunk) => {
    chunks.push(chunk);
  });

  const process = processes.started[0];
  assert.deepEqual(process.input, [
    `${512 * 1024}\n`,
    `${512 * 1024}\n`,
  ]);
  assert.deepEqual(
    chunks.flatMap((chunk) => Array.from(chunk)),
    Array.from(content),
  );
  assert.equal(process.env.ARCHIL_FILE_PATH, "/workspace/result.bin");
  assert.match(process.env.ARCHIL_FILE_TEMP, /^\/tmp\/\.archil-download-/);
  assert.equal(process.collectOutput, false);
  assert.equal(process.disconnected, true);
});

test("downloadFile reads a zero-length chunk after an exact multiple", async () => {
  const content = new Uint8Array(512 * 1024);
  const processes = new FakeProcesses(content);
  let written = 0;

  await files(processes).downloadFile("/workspace/result.bin", (chunk) => {
    written += chunk.byteLength;
  });

  assert.equal(written, content.byteLength);
  assert.deepEqual(processes.started[0].input, [
    `${512 * 1024}\n`,
    `${512 * 1024}\n`,
  ]);
});

test("downloadFile rejects replay gaps", async () => {
  const processes = new FakeProcesses(new Uint8Array([1, 2, 3]), true);

  await assert.rejects(
    files(processes).downloadFile("/workspace/result.bin", () => {}),
    (error: unknown) =>
      error instanceof SandboxFileTransferError &&
      error.message.includes("output gap"),
  );

  assert.equal(processes.started[0].killed, true);
  assert.equal(processes.started[0].disconnected, true);
});

test("file transfer paths must be absolute", async () => {
  const sandboxFiles = files(new FakeProcesses());

  await assert.rejects(
    sandboxFiles.uploadFile(new Uint8Array(), "relative/path"),
    /absolute file path/,
  );
  await assert.rejects(
    sandboxFiles.downloadFile("/", () => {}),
    /absolute file path/,
  );
});
