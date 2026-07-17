import { Buffer } from "node:buffer";
import { Workspace } from "disk";
import type {
  Disk,
  ExecMount,
  ExecMountSpec,
  ExecOptions,
  ExecResult,
  FileSystem,
  GrepOptions,
  GrepResult,
  ListObjectsOptions,
  ListObjectsResult,
  PutObjectOptions,
  PutObjectResult,
} from "disk";

export interface MockDiskCallLog {
  getObject: string[];
  putObject: Array<{ key: string; contentType?: string; mode?: number; uid?: number; gid?: number }>;
  deleteObject: string[];
  listObjects: Array<{ prefix?: string; opts: ListObjectsOptions }>;
  grep: GrepOptions[];
  exec: string[];
}

export interface MockDiskControls {
  readonly files: Map<string, Uint8Array>;
  readonly calls: MockDiskCallLog;
  setText(key: string, content: string): void;
  getText(key: string): string | undefined;
  setBytes(key: string, content: Uint8Array): void;
  getBytes(key: string): Uint8Array | undefined;
  clearCalls(): void;
}

export type MockDisk = Disk & MockDiskControls;

export interface MockDiskOptions {
  id?: string;
  name?: string;
  files?: Record<string, string | Uint8Array>;
  exec?: (command: string) => ExecResult | Promise<ExecResult>;
}

export interface MockWorkspaceControls {
  readonly disks: Record<string, MockDisk>;
  readonly execCalls: ExecOptions[];
}

export type MockWorkspace = Workspace & MockWorkspaceControls;

export type MockWorkspaceMount =
  | MockDisk
  | (Omit<ExecMountSpec, "disk"> & { disk: MockDisk | string });

export interface MockWorkspaceOptions {
  exec?: (opts: ExecOptions) => ExecResult | Promise<ExecResult>;
}

export function createMockDisk(options: MockDiskOptions = {}): MockDisk {
  return new MockDiskImpl(options) as unknown as MockDisk;
}

export function createMockWorkspace(
  mounts: Record<string, MockWorkspaceMount>,
  options: MockWorkspaceOptions = {},
): MockWorkspace {
  const execCalls: ExecOptions[] = [];
  const exec = async (opts: ExecOptions) => {
    execCalls.push(opts);
    return options.exec?.(opts) ?? defaultExecResult();
  };
  const workspace = new Workspace({ exec }, mounts as Record<string, ExecMount>) as MockWorkspace;
  const disks = Object.fromEntries(
    Object.entries(mounts)
      .map(([name, mount]) => [name, isMountSpec(mount) ? mount.disk : mount])
      .filter((entry): entry is [string, MockDisk] => typeof entry[1] !== "string"),
  );
  Object.defineProperties(workspace, {
    disks: { value: disks },
    execCalls: { value: execCalls },
  });
  return workspace;
}

class MockDiskImpl implements FileSystem {
  readonly id: string;
  readonly name: string;
  readonly files = new Map<string, Uint8Array>();
  readonly calls: MockDiskCallLog = {
    getObject: [],
    putObject: [],
    deleteObject: [],
    listObjects: [],
    grep: [],
    exec: [],
  };

  private readonly execHandler: ((command: string) => ExecResult | Promise<ExecResult>) | undefined;

  constructor(options: MockDiskOptions) {
    this.id = options.id ?? "dsk-mock";
    this.name = options.name ?? this.id;
    this.execHandler = options.exec;
    for (const [key, content] of Object.entries(options.files ?? {})) {
      this.setBytes(key, toBytes(content));
    }
  }

  async getObject(key: string): Promise<Uint8Array> {
    const normalized = normalizeKey(key);
    this.calls.getObject.push(normalized);
    const content = this.files.get(normalized);
    if (content === undefined) throw notFound(normalized);
    return copyBytes(content);
  }

  async putObject(
    key: string,
    body: string | Uint8Array | ArrayBuffer,
    options?: string | PutObjectOptions,
  ): Promise<PutObjectResult> {
    const opts: PutObjectOptions = typeof options === "string" ? { contentType: options } : options ?? {};
    const normalized = normalizeKey(key);
    // Record mode/uid/gid only when set — an own property with value undefined
    // would break callers' deepEqual assertions on `{ key, contentType }` logs.
    this.calls.putObject.push({
      key: normalized,
      contentType: opts.contentType,
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    });
    this.files.set(normalized, toBytes(body));
    return { etag: '"mock"' };
  }

  async deleteObject(key: string): Promise<void> {
    const normalized = normalizeKey(key);
    this.calls.deleteObject.push(normalized);
    this.files.delete(normalized);
  }

  async listObjects(prefix?: string, opts: ListObjectsOptions = {}): Promise<ListObjectsResult> {
    const normalizedPrefix = prefix === undefined ? undefined : normalizePrefix(prefix);
    this.calls.listObjects.push({ prefix: normalizedPrefix, opts });
    const prefixValue = normalizedPrefix ?? "";
    const objects: Array<{ key: string; size: number }> = [];
    const commonPrefixes = new Set<string>();

    for (const [key, content] of [...this.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.startsWith(prefixValue)) continue;
      if (!opts.recursive) {
        const rest = key.slice(prefixValue.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          commonPrefixes.add(`${prefixValue}${rest.slice(0, slash + 1)}`);
          continue;
        }
      }
      objects.push({ key, size: content.byteLength });
    }

    const limit = opts.limit;
    const limitedObjects = limit === undefined ? objects : objects.slice(0, limit);
    return {
      objects: limitedObjects,
      commonPrefixes: [...commonPrefixes].sort(),
      isTruncated: limitedObjects.length < objects.length,
      keyCount: limitedObjects.length,
      prefix: prefixValue,
    };
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    this.calls.grep.push({ ...opts });
    const directory = normalizePrefix(opts.directory ?? "");
    const pattern = new RegExp(opts.pattern);
    const maxResults = opts.maxResults ?? 1000;
    const matches: GrepResult["matches"] = [];
    let filesScanned = 0;

    for (const [key, content] of [...this.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (directory && !key.startsWith(directory)) continue;
      filesScanned += 1;
      const text = Buffer.from(content).toString("utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        pattern.lastIndex = 0;
        if (!pattern.test(lines[i])) continue;
        matches.push({ file: key, line: i + 1, text: lines[i] });
        if (matches.length >= maxResults) {
          return grepResult(matches, "max_results", filesScanned);
        }
      }
    }

    return grepResult(matches, "completed", filesScanned);
  }

  async exec(command: string): Promise<ExecResult> {
    this.calls.exec.push(command);
    return this.execHandler?.(command) ?? defaultExecResult();
  }

  setText(key: string, content: string): void {
    this.setBytes(key, Buffer.from(content, "utf8"));
  }

  getText(key: string): string | undefined {
    const content = this.getBytes(key);
    return content === undefined ? undefined : Buffer.from(content).toString("utf8");
  }

  setBytes(key: string, content: Uint8Array): void {
    this.files.set(normalizeKey(key), copyBytes(content));
  }

  getBytes(key: string): Uint8Array | undefined {
    const content = this.files.get(normalizeKey(key));
    return content === undefined ? undefined : copyBytes(content);
  }

  clearCalls(): void {
    this.calls.getObject.length = 0;
    this.calls.putObject.length = 0;
    this.calls.deleteObject.length = 0;
    this.calls.listObjects.length = 0;
    this.calls.grep.length = 0;
    this.calls.exec.length = 0;
  }
}

function isMountSpec(value: MockWorkspaceMount): value is Omit<ExecMountSpec, "disk"> & { disk: MockDisk | string } {
  return typeof value === "object" && value !== null && "disk" in value;
}

function normalizeKey(key: string): string {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

function normalizePrefix(prefix: string): string {
  const key = normalizeKey(prefix);
  if (key.length === 0) return "";
  return prefix.endsWith("/") ? `${key}/` : key;
}

function toBytes(content: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
  return copyBytes(content);
}

function copyBytes(content: Uint8Array): Uint8Array {
  return new Uint8Array(content);
}

function notFound(key: string): Error & { status: number; path: string } {
  return Object.assign(new Error(`file not found: ${key}`), { status: 404, path: key });
}

function defaultExecResult(): ExecResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
  };
}

function grepResult(
  matches: GrepResult["matches"],
  stoppedReason: GrepResult["stoppedReason"],
  filesScanned: number,
): GrepResult {
  return {
    matches,
    stoppedReason,
    filesScanned,
    containersDispatched: 0,
    computeSecondsUsed: 0,
    durationMs: 0,
    listingMs: 0,
    grepMs: 0,
  };
}
