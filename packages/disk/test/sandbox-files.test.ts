import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

class FakeSandbox {
  readonly started: FakeProcess[] = [];

  constructor(
    private readonly _content = new Uint8Array(),
    private readonly _gap = false,
  ) {}

  async run(
    command: string,
    options: SandboxProcessStartOptions = {},
  ): Promise<SandboxProcess> {
    const process = new FakeProcess(command, options, this._content, this._gap);
    this.started.push(process);
    return process as unknown as SandboxProcess;
  }
}

function files(processes: FakeSandbox): SandboxFiles {
  return new SandboxFiles(processes);
}

test("uploadFile streams source chunks through the process API", async () => {
  const processes = new FakeSandbox();
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
  const processes = new FakeSandbox(content);
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
  assert.equal(process.collectOutput, false);
  assert.equal(process.disconnected, true);
});

test("downloadFile reads a zero-length chunk after an exact multiple", async () => {
  const content = new Uint8Array(512 * 1024);
  const processes = new FakeSandbox(content);
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
  const processes = new FakeSandbox(new Uint8Array([1, 2, 3]), true);

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
  const sandboxFiles = files(new FakeSandbox());

  await assert.rejects(
    sandboxFiles.uploadFile(new Uint8Array(), "relative/path"),
    /absolute file path/,
  );
  await assert.rejects(
    sandboxFiles.downloadFile("/", () => {}),
    /absolute file path/,
  );
});

function runScript(script: string, env: Record<string, string>): ChildProcess {
  return spawn("sh", ["-c", script], {
    env: { ...globalThis.process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("close", resolve));
}

async function waitForEntry(directory: string, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const entries = await readdir(directory).catch(() => []);
    const entry = entries.find((name) => name.startsWith(prefix));
    if (entry) return join(directory, entry);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${prefix} file appeared in ${directory}`);
}

async function groupOrOtherBits(path: string): Promise<number> {
  return (await stat(path)).mode & 0o077;
}

test("upload keeps its temp file private until the final chmod", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archil-upload-"));
  let child: ChildProcess | undefined;
  try {
    const target = join(directory, "tests", "hidden.py");
    child = runScript(sandboxFileCommands.upload, {
      ARCHIL_FILE_PARENT: join(directory, "tests"),
      ARCHIL_FILE_TARGET: target,
      ARCHIL_FILE_MODE: "644",
    });
    const exited = exitCode(child);
    child.stdin?.write("assert solve() == 42\n");

    const temp = await waitForEntry(join(directory, "tests"), ".archil-upload.");
    assert.equal(await groupOrOtherBits(temp), 0);

    child.stdin?.end();
    assert.equal(await exited, 0);
    assert.equal(await readFile(target, "utf8"), "assert solve() == 42\n");
    assert.equal((await stat(target)).mode & 0o777, 0o644);
    assert.deepEqual(await readdir(join(directory, "tests")), ["hidden.py"]);
  } finally {
    child?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("download chunks never land in a readable temp file, even when killed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archil-download-"));
  const temps = await mkdtemp(join(tmpdir(), "archil-download-tmp-"));
  let child: ChildProcess | undefined;
  try {
    const source = join(directory, "answers.txt");
    await writeFile(source, "secret");
    child = runScript(sandboxFileCommands.download, {
      ARCHIL_FILE_PATH: source,
      TMPDIR: temps,
    });
    const exited = exitCode(child);
    const output: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));

    const temp = await waitForEntry(temps, ".archil-download.");
    child.stdin?.write("3\n");
    while (Buffer.concat(output).toString().trim() !== "3\nsec") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await groupOrOtherBits(temp), 0);

    child.kill("SIGKILL");
    await exited;
    for (const leftover of await readdir(temps)) {
      assert.equal(await groupOrOtherBits(join(temps, leftover)), 0);
    }
  } finally {
    child?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
    await rm(temps, { recursive: true, force: true });
  }
});
