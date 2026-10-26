import type { Sandbox } from "./sandbox.js";
import { SandboxFileTransferError } from "./errors.js";
import type {
  SandboxProcess,
  SandboxProcessOutput,
  SandboxProcessResult,
} from "./sandbox-process.js";

export type SandboxFileSource =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;

export type SandboxFileWriter = (
  chunk: Uint8Array,
) => void | Promise<void>;

export interface SandboxFileUploadOptions {
  mode?: number;
}

const DOWNLOAD_CHUNK_BYTES = 512 * 1024;

const UPLOAD_COMMAND = `set -eu
mkdir -p "$ARCHIL_FILE_PARENT"
trap 'rm -f "$ARCHIL_FILE_TEMP"' EXIT HUP INT TERM
: > "$ARCHIL_FILE_TEMP"
cat > "$ARCHIL_FILE_TEMP"
chmod "$ARCHIL_FILE_MODE" "$ARCHIL_FILE_TEMP"
mv -f "$ARCHIL_FILE_TEMP" "$ARCHIL_FILE_TARGET"
trap - EXIT HUP INT TERM`;

const DOWNLOAD_COMMAND = `set -eu
trap 'rm -f "$ARCHIL_FILE_TEMP"' EXIT HUP INT TERM
exec 3< "$ARCHIL_FILE_PATH"
while IFS= read -r count; do
    dd bs="$count" count=1 <&3 > "$ARCHIL_FILE_TEMP" 2>/dev/null
    size=$(wc -c < "$ARCHIL_FILE_TEMP")
    printf '%s\n' "$size"
    cat "$ARCHIL_FILE_TEMP"
    [ "$size" -eq "$count" ] || break
done`;

class ProcessOutputReader {
  private _buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private _cursor = 0;
  private readonly _stderrDecoder = new TextDecoder();
  private _stderr = "";
  private _process!: SandboxProcess;
  private _output!: AsyncIterator<SandboxProcessOutput>;

  attach(process: SandboxProcess): void {
    this._process = process;
    this._output = process.output[Symbol.asyncIterator]();
  }
  async readLine(): Promise<Uint8Array> {
    while (true) {
      const newline = this._buffer.indexOf(10);
      if (newline >= 0) {
        const line = this._buffer.slice(0, newline);
        this._buffer = this._buffer.slice(newline + 1);
        return line;
      }
      this._buffer = concat(this._buffer, await this._nextChunk());
    }
  }
  async read(size: number): Promise<Uint8Array> {
    while (this._buffer.length < size) this._buffer = concat(this._buffer, await this._nextChunk());
    const data = this._buffer.slice(0, size);
    this._buffer = this._buffer.slice(size);
    return data;
  }
  async wait(): Promise<void> {
    while (!(await this._output.next()).done) { /* Drain trailing diagnostics. */ }
    assertSuccessful(await this._process.wait(), this._stderr + this._stderrDecoder.decode());
  }
  private async _nextChunk(): Promise<Uint8Array> {
    while (true) {
      const next = await this._output.next();
      if (next.done) {
        assertSuccessful(await this._process.wait(), this._stderr + this._stderrDecoder.decode());
        throw new Error("Sandbox process exited before file transfer completed");
      }
      const output = next.value;
      if (output.offset !== this._cursor) throw new Error(
        `Sandbox process output gap: expected offset ${this._cursor}, received ${output.offset}`);
      this._cursor += output.data.length;
      if (output.stream === "stdout") return output.data;
      this._stderr += this._stderrDecoder.decode(output.data, { stream: true });
    }
  }
}

export class SandboxFiles {
  private readonly _sandbox: Pick<Sandbox, "run">;

  /** @internal */
  constructor(sandbox: Pick<Sandbox, "run">) {
    this._sandbox = sandbox;
  }

  async uploadFile(
    source: SandboxFileSource,
    remotePath: string,
    options: SandboxFileUploadOptions = {},
  ): Promise<void> {
    const { path, parent } = remoteFilePath(remotePath);
    const mode = options.mode ?? 0o644;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new RangeError("mode must be between 0 and 0o7777");
    }

    let process: SandboxProcess | undefined;
    try {
      process = await this._sandbox.run(UPLOAD_COMMAND, {
        env: {
          ARCHIL_FILE_PARENT: parent,
          ARCHIL_FILE_TARGET: path,
          ARCHIL_FILE_TEMP: `${parent}/.archil-upload-${transferId()}`,
          ARCHIL_FILE_MODE: mode.toString(8),
        },
      });
      for await (const chunk of fileChunks(source)) {
        await process.sendInput(chunk);
      }
      await process.closeStdin();
      assertSuccessful(await process.wait());
    } catch (error) {
      if (process) await abort(process);
      if (error instanceof RangeError || error instanceof TypeError) throw error;
      throw new SandboxFileTransferError("upload", path, toError(error));
    } finally {
      await process?.disconnect();
    }
  }

  async downloadFile(
    remotePath: string,
    write: SandboxFileWriter,
  ): Promise<void> {
    const { path } = remoteFilePath(remotePath);
    const reader = new ProcessOutputReader();
    let process: SandboxProcess | undefined;
    try {
      process = await this._sandbox.run(DOWNLOAD_COMMAND, {
        env: {
          ARCHIL_FILE_PATH: path,
          ARCHIL_FILE_TEMP: `/tmp/.archil-download-${transferId()}`,
        },
        collectOutput: false,
      });
      reader.attach(process);
      while (true) {
        await process.sendInput(`${DOWNLOAD_CHUNK_BYTES}\n`);
        const sizeText = new TextDecoder().decode(await reader.readLine()).trim();
        const size = Number(sizeText);
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > DOWNLOAD_CHUNK_BYTES
        ) {
          throw new Error(
            `Sandbox returned an invalid chunk size: ${JSON.stringify(sizeText)}`,
          );
        }
        if (size === 0) break;
        const data = await reader.read(size);
        await write(data);
        if (size < DOWNLOAD_CHUNK_BYTES) break;
      }
      await reader.wait();
    } catch (error) {
      if (process) await abort(process);
      if (error instanceof RangeError || error instanceof TypeError) throw error;
      throw new SandboxFileTransferError("download", path, toError(error));
    } finally {
      await process?.disconnect();
    }
  }
}

async function* fileChunks(source: SandboxFileSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source);
    return;
  }
  if (source instanceof Blob) {
    yield* readableChunks(source.stream());
    return;
  }
  if (Symbol.asyncIterator in source) {
    for await (const chunk of source) yield new Uint8Array(chunk);
    return;
  }
  yield* readableChunks(source);
}

async function* readableChunks(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function remoteFilePath(path: string): { path: string; parent: string } {
  if (path.includes("\0")) throw new TypeError("remote path cannot contain NUL");
  if (!path.startsWith("/") || path.endsWith("/")) {
    throw new TypeError("remote path must be an absolute file path");
  }
  return { path, parent: path.slice(0, path.lastIndexOf("/")) || "/" };
}

function assertSuccessful(
  result: SandboxProcessResult,
  stderr = result.stderr,
): void {
  if (result.status === "completed" && result.exitCode === 0) return;
  throw new Error(
    stderr.trim() || result.exitReason || `exit code ${String(result.exitCode)}`,
  );
}

async function abort(process: SandboxProcess): Promise<void> {
  try {
    await process.kill();
  } catch {}
}

function transferId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** @internal */
export const sandboxFileCommands = {
  upload: UPLOAD_COMMAND,
  download: DOWNLOAD_COMMAND,
};
