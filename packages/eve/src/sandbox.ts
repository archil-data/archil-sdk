import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  Archil,
  type Disk,
  type ExecMountSpec,
  type ExecOptions,
  type ExecResult,
} from "disk";
import {
  SandboxTemplateNotProvisionedError,
  type SandboxBackend,
  type SandboxBackendCreateInput,
  type SandboxBackendHandle,
  type SandboxBackendPrewarmInput,
  type SandboxNetworkPolicy,
  type SandboxProcess,
  type SandboxSeedFile,
  type SandboxSession,
} from "eve/sandbox";

const BACKEND_NAME = "archil";
const DEFAULT_ROOT_PREFIX = ".eve/sandbox";
const CONTROL_MOUNT = "store";
const WORKSPACE_MOUNT = "workspace";
const CONTROL_ROOT = `/mnt/archil/${CONTROL_MOUNT}`;
const WORKSPACE_ROOT = "/workspace";
const WORKSPACE_MOUNT_ROOT = `/mnt/archil/${WORKSPACE_MOUNT}`;
const TEMPLATE_READY_FILE = ".archil-eve-template-ready";
const SESSION_READY_FILE = ".archil-eve-session-ready";
const MISSING_TEMPLATE_EXIT_CODE = 67;
const DEFAULT_WRITE_QUEUE_MS = 5000;

export interface ArchilBackendOptions {
  /** Disk that stores sandbox templates and durable session workspaces. */
  readonly disk: Disk | string;
  /** Existing Archil client. When omitted, one is created from environment config. */
  readonly client?: Archil;
  /** Directory on the disk where Eve template/session state is stored. */
  readonly rootPrefix?: string;
  /** Delegation queue timeout passed to Archil write exec mounts. Defaults to 5000. */
  readonly queueMs?: number;
}

export function archilBackend(
  options: ArchilBackendOptions,
): SandboxBackend {
  return new ArchilBackend(options);
}

interface ExecWorkspaceOptions {
  readonly checkoutPaths?: string[];
  readonly readOnly?: boolean;
}

class ArchilBackend implements SandboxBackend {
  private readonly client: Archil;
  private readonly disk: Disk | string;
  private readonly rootPrefix: string;
  private readonly queueMs: number;
  private controlParentsReady: Promise<void> | undefined;
  private diskReady: Promise<Disk> | undefined;

  readonly name: string = BACKEND_NAME;

  constructor(options: ArchilBackendOptions) {
    this.client = options.client ?? new Archil();
    this.disk = options.disk;
    this.rootPrefix = normalizeDiskPath(options.rootPrefix ?? DEFAULT_ROOT_PREFIX);
    this.queueMs = options.queueMs ?? DEFAULT_WRITE_QUEUE_MS;
  }

  async prewarm(
    input: SandboxBackendPrewarmInput,
  ): Promise<{ reused: boolean }> {
    await this.ensureControlParents();
    const templateSubdirectory = this.templateSubdirectory(input.templateKey);
    const templateReadyPath = joinDiskPath(templateSubdirectory, TEMPLATE_READY_FILE);
    const tempSubdirectory = this.tempSubdirectory("template", input.templateKey);
    const templateParentSubdirectory = this.templateParentSubdirectory();
    const prepareCommands = [
      "set -e",
      `if [ -e ${shellQuote(controlPath(templateReadyPath))} ]; then printf reused; exit 0; fi`,
      `rm -rf ${shellQuote(controlPath(tempSubdirectory))}`,
      `mkdir -p ${shellQuote(controlPath(tempSubdirectory))}`,
    ];

    const prepareResult = await this.execControl(
      prepareCommands.join("\n"),
      [templateParentSubdirectory],
    );
    expectSuccess(prepareResult, "prepare sandbox template directory");
    if (prepareResult.stdout === "reused") return { reused: true };

    if (input.bootstrap !== undefined) {
      const session = this.createSession(input.templateKey, tempSubdirectory);
      await input.bootstrap({ use: async () => session });
    }

    await this.writeSeedFiles(input.seedFiles, tempSubdirectory);

    const publishResult = await this.execControl(
      publishDirectoryCommands(tempSubdirectory, templateSubdirectory, TEMPLATE_READY_FILE).join("\n"),
      [templateParentSubdirectory],
    );
    expectSuccess(publishResult, "publish sandbox template");

    return { reused: false };
  }

  async create(
    input: SandboxBackendCreateInput,
  ): Promise<SandboxBackendHandle> {
    const sessionSubdirectory = this.sessionSubdirectory(input.sessionKey);
    await this.ensureSession(input, sessionSubdirectory);
    const session = this.createSession(input.sessionKey, sessionSubdirectory);
    return {
      session,
      useSessionFn: async () => session,
      captureState: async () => ({
        backendName: BACKEND_NAME,
        metadata: {
          rootPrefix: this.rootPrefix,
          sessionSubdirectory,
        },
        sessionKey: input.sessionKey,
      }),
      dispose: async () => {},
    };
  }

  private async ensureSession(
    input: SandboxBackendCreateInput,
    sessionSubdirectory: string,
  ): Promise<void> {
    await this.ensureControlParents();
    const sessionReadyPath = joinDiskPath(sessionSubdirectory, SESSION_READY_FILE);
    const tempSubdirectory = this.tempSubdirectory("session", input.sessionKey);
    const sessionParentSubdirectory = this.sessionParentSubdirectory();
    const commands = [
      "set -e",
      `if [ -e ${shellQuote(controlPath(sessionReadyPath))} ]; then exit 0; fi`,
    ];

    if (input.templateKey !== null) {
      const templateSubdirectory = this.templateSubdirectory(input.templateKey);
      const templateReadyPath = joinDiskPath(templateSubdirectory, TEMPLATE_READY_FILE);
      commands.push(
        `if [ ! -e ${shellQuote(controlPath(templateReadyPath))} ]; then exit ${MISSING_TEMPLATE_EXIT_CODE}; fi`,
      );
    }

    commands.push(
      `rm -rf ${shellQuote(controlPath(tempSubdirectory))}`,
      `mkdir -p ${shellQuote(controlPath(tempSubdirectory))}`,
    );

    if (input.templateKey !== null) {
      const templateSubdirectory = this.templateSubdirectory(input.templateKey);
      commands.push(
        `cp -a ${shellQuote(`${controlPath(templateSubdirectory)}/.`)} ${shellQuote(controlPath(tempSubdirectory))}`,
      );
    }

    commands.push(
      ...publishDirectoryCommands(tempSubdirectory, sessionSubdirectory, SESSION_READY_FILE),
    );

    const createResult = await this.execControl(
      commands.join("\n"),
      [sessionParentSubdirectory],
    );
    if (createResult.exitCode === MISSING_TEMPLATE_EXIT_CODE && input.templateKey !== null) {
      throw new SandboxTemplateNotProvisionedError({
        backendName: BACKEND_NAME,
        templateKey: input.templateKey,
      });
    }
    expectSuccess(createResult, "create sandbox session");
  }

  private createSession(id: string, subdirectory: string): SandboxSession {
    return new ArchilSession({
      getObject: (path) => this.readSessionObject(subdirectory, path),
      exec: (command, options) => this.execWorkspace(subdirectory, command, options),
      id,
      putObject: (path, content) => this.writeSessionObject(subdirectory, path, content),
    });
  }

  private async execControl(
    command: string,
    checkoutPaths?: string[],
  ): Promise<ExecResult> {
    return this.execRaw({
      disks: { [CONTROL_MOUNT]: this.controlMount(checkoutPaths) },
      command,
    });
  }

  private async execWorkspace(
    subdirectory: string,
    command: string,
    options: ExecWorkspaceOptions = {},
  ): Promise<ExecResult> {
    return this.execRaw({
      disks: {
        [WORKSPACE_MOUNT]: this.workspaceMount(
          subdirectory,
          options.readOnly === true ? undefined : options.checkoutPaths,
          options.readOnly === true,
        ),
      },
      command,
    });
  }

  private async execRaw(opts: ExecOptions): Promise<ExecResult> {
    return this.client.exec(opts);
  }

  private async dataDisk(): Promise<Disk> {
    if (typeof this.disk !== "string") return this.disk;
    if (this.diskReady === undefined) {
      this.diskReady = this.client.disks.get(this.disk).catch((error) => {
        this.diskReady = undefined;
        throw error;
      });
    }
    return this.diskReady;
  }

  private async readSessionObject(
    subdirectory: string,
    path: string,
  ): Promise<Uint8Array | null> {
    try {
      return await (await this.dataDisk()).getObject(sessionObjectKey(subdirectory, path));
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  private async writeSessionObject(
    subdirectory: string,
    path: string,
    content: Uint8Array,
  ): Promise<void> {
    await (await this.dataDisk()).putObject(sessionObjectKey(subdirectory, path), content);
  }

  private async writeSeedFiles(
    seedFiles: ReadonlyArray<SandboxSeedFile>,
    subdirectory: string,
  ): Promise<void> {
    if (seedFiles.length === 0) return;
    const disk = await this.dataDisk();
    await Promise.all(seedFiles.map((seed) =>
      disk.putObject(seedObjectKey(subdirectory, seed.path), Buffer.from(seed.content)),
    ));
  }

  private controlMount(checkoutPaths: string[] | undefined): ExecMountSpec {
    return {
      disk: this.disk,
      queueMs: this.queueMs,
      checkoutPaths,
    };
  }

  private workspaceMount(
    subdirectory: string,
    checkoutPaths: string[] | undefined,
    readOnly: boolean,
  ): ExecMountSpec {
    if (readOnly) {
      return {
        disk: this.disk,
        subdirectory,
        readOnly: true,
      };
    }
    const mount: ExecMountSpec = {
      disk: this.disk,
      subdirectory,
      queueMs: this.queueMs,
      checkoutPaths,
    };
    return mount;
  }

  private templateSubdirectory(templateKey: string): string {
    return joinDiskPath(this.rootPrefix, "templates", stablePathSegment(templateKey));
  }

  private templateParentSubdirectory(): string {
    return joinDiskPath(this.rootPrefix, "templates");
  }

  private sessionSubdirectory(sessionKey: string): string {
    return joinDiskPath(this.rootPrefix, "sessions", stablePathSegment(sessionKey));
  }

  private sessionParentSubdirectory(): string {
    return joinDiskPath(this.rootPrefix, "sessions");
  }

  private tempSubdirectory(kind: "session" | "template", key: string): string {
    const parent = kind === "template"
      ? this.templateParentSubdirectory()
      : this.sessionParentSubdirectory();
    return joinDiskPath(parent, `.tmp-${stablePathSegment(key)}`);
  }

  private async ensureControlParents(): Promise<void> {
    if (this.controlParentsReady === undefined) {
      this.controlParentsReady = this.execControl(
        [
          "set -e",
          `mkdir -p ${[
            this.templateParentSubdirectory(),
            this.sessionParentSubdirectory(),
          ].map((path) => shellQuote(controlPath(path))).join(" ")}`,
        ].join("\n"),
      ).then((result) => {
        expectSuccess(result, "prepare sandbox control directories");
      }).catch((error) => {
        this.controlParentsReady = undefined;
        throw error;
      });
    }
    await this.controlParentsReady;
  }
}

class ArchilSession implements SandboxSession {
  private readonly exec: (
    command: string,
    options?: ExecWorkspaceOptions,
  ) => Promise<ExecResult>;
  private readonly getObject: (path: string) => Promise<Uint8Array | null>;
  private readonly putObject: (path: string, content: Uint8Array) => Promise<void>;

  readonly id: string;

  constructor(input: {
    readonly exec: (
      command: string,
      options?: ExecWorkspaceOptions,
    ) => Promise<ExecResult>;
    readonly getObject: (path: string) => Promise<Uint8Array | null>;
    readonly id: string;
    readonly putObject: (path: string, content: Uint8Array) => Promise<void>;
  }) {
    this.exec = input.exec;
    this.getObject = input.getObject;
    this.id = input.id;
    this.putObject = input.putObject;
  }

  resolvePath(path: string): string {
    return resolvePath(path);
  }

  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
    return unsupportedNetworkPolicy(policy);
  }

  async run(
    options: Parameters<SandboxSession["run"]>[0],
  ): Promise<Awaited<ReturnType<SandboxSession["run"]>>> {
    throwIfAborted(options.abortSignal);
    return this.exec(buildRunCommand(options));
  }

  async spawn(
    options: Parameters<SandboxSession["spawn"]>[0],
  ): Promise<SandboxProcess> {
    throwIfAborted(options.abortSignal);
    const result = this.exec(buildRunCommand(options));
    return {
      stdout: streamFromExecResult(result, "stdout"),
      stderr: streamFromExecResult(result, "stderr"),
      wait: async () => ({ exitCode: (await result).exitCode }),
      kill: async () => {},
    };
  }

  async readFile(
    options: Parameters<SandboxSession["readFile"]>[0],
  ): Promise<ReadableStream<Uint8Array> | null> {
    const content = await this.readBinaryFile(options);
    return content === null ? null : bufferToStream(content);
  }

  async readBinaryFile(
    options: Parameters<SandboxSession["readBinaryFile"]>[0],
  ): Promise<Uint8Array | null> {
    throwIfAborted(options.abortSignal);
    return this.getObject(options.path);
  }

  async readTextFile(
    options: Parameters<SandboxSession["readTextFile"]>[0],
  ): Promise<string | null> {
    const content = await this.readBinaryFile(options);
    if (content === null) return null;
    const text = Buffer.from(content).toString((options.encoding ?? "utf-8") as BufferEncoding);
    return applyLineRange(text, options.startLine, options.endLine);
  }

  async writeFile(
    options: Parameters<SandboxSession["writeFile"]>[0],
  ): Promise<void> {
    const content = await streamToBuffer(options.content);
    await this.writeBinaryFile({
      abortSignal: options.abortSignal,
      path: options.path,
      content,
    });
  }

  async writeBinaryFile(
    options: Parameters<SandboxSession["writeBinaryFile"]>[0],
  ): Promise<void> {
    throwIfAborted(options.abortSignal);
    await this.putObject(options.path, options.content);
  }

  async writeTextFile(
    options: Parameters<SandboxSession["writeTextFile"]>[0],
  ): Promise<void> {
    await this.writeBinaryFile({
      abortSignal: options.abortSignal,
      path: options.path,
      content: Buffer.from(options.content, (options.encoding ?? "utf-8") as BufferEncoding),
    });
  }

  async removePath(
    options: Parameters<SandboxSession["removePath"]>[0],
  ): Promise<void> {
    throwIfAborted(options.abortSignal);
    const path = resolvePath(options.path);
    const flags = `${options.recursive === true ? "r" : ""}${options.force === true ? "f" : ""}`;
    const result = await this.exec(
      [
        ensureWorkspaceCommand(),
        `rm ${flags.length > 0 ? `-${flags} ` : ""}-- ${shellQuote(path)}`,
      ].join(" && "),
      { checkoutPaths: checkoutPaths(workspaceRelativePath(posix.dirname(path))) },
    );
    expectSuccess(result, `remove ${path}`);
  }
}

function buildRunCommand(options: Parameters<SandboxSession["run"]>[0]): string {
  const cwd = resolvePath(options.workingDirectory ?? WORKSPACE_ROOT);
  const env = Object.entries(options.env ?? {})
    .map(([key, value]) => shellQuote(`${key}=${value}`))
    .join(" ");
  const command = env.length > 0
    ? `env ${env} bash -lc ${shellQuote(options.command)}`
    : `bash -lc ${shellQuote(options.command)}`;
  return [
    ensureWorkspaceCommand(),
    `cd ${shellQuote(cwd)}`,
    command,
  ].join(" && ");
}

function ensureWorkspaceCommand(): string {
  return [
    `rm -rf ${shellQuote(WORKSPACE_ROOT)}`,
    `ln -s ${shellQuote(WORKSPACE_MOUNT_ROOT)} ${shellQuote(WORKSPACE_ROOT)}`,
  ].join(" && ");
}

function resolvePath(path: string): string {
  if (path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`)) return path;
  const relativePath = path.replace(/^\/+/, "");
  return relativePath.length === 0 ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${relativePath}`;
}

async function unsupportedNetworkPolicy(_policy: SandboxNetworkPolicy): Promise<void> {
  throw new Error(
    "setNetworkPolicy() is not supported by archil(); Archil does not expose per-session network policy controls.",
  );
}

function streamFromExecResult(
  result: Promise<ExecResult>,
  key: "stdout" | "stderr",
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        const text = (await result)[key];
        if (text.length > 0) {
          controller.enqueue(new TextEncoder().encode(text));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function bufferToStream(content: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    byteLength += value.byteLength;
  }
  return Buffer.concat(chunks, byteLength);
}

function applyLineRange(
  text: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split(/(?<=\n)/);
  const start = Math.max((startLine ?? 1) - 1, 0);
  const end = endLine === undefined ? lines.length : endLine;
  return lines.slice(start, end).join("");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

function expectSuccess(result: ExecResult, description: string): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `Archil failed to ${description} with exit code ${result.exitCode}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function publishDirectoryCommands(
  tempSubdirectory: string,
  targetSubdirectory: string,
  readyFile: string,
): string[] {
  return [
    `touch ${shellQuote(controlPath(joinDiskPath(tempSubdirectory, readyFile)))}`,
    `rm -rf ${shellQuote(controlPath(targetSubdirectory))}`,
    `mkdir -p ${shellQuote(controlPath(posix.dirname(targetSubdirectory)))}`,
    `mv ${shellQuote(controlPath(tempSubdirectory))} ${shellQuote(controlPath(targetSubdirectory))}`,
  ];
}

function seedObjectKey(subdirectory: string, path: string): string {
  return joinDiskPath(subdirectory, workspaceRelativePath(path));
}

function sessionObjectKey(subdirectory: string, path: string): string {
  return joinDiskPath(subdirectory, workspaceRelativePath(path));
}

function workspaceRelativePath(path: string): string {
  return normalizeDiskPath(resolvePath(path).slice(WORKSPACE_ROOT.length));
}

function isMissingObjectError(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

function checkoutPaths(...paths: string[]): string[] | undefined {
  const scopedPaths = paths.filter((path) => path.length > 0);
  return scopedPaths.length === 0 ? undefined : scopedPaths;
}

function stablePathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function controlPath(path: string): string {
  const relativePath = normalizeDiskPath(path);
  return relativePath.length === 0 ? CONTROL_ROOT : `${CONTROL_ROOT}/${relativePath}`;
}

function normalizeDiskPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function joinDiskPath(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter((part) => part.length > 0)
    .join("/");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
