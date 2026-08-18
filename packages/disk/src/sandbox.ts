import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap, unwrapEmpty } from "./client.js";
import { SandboxProcesses } from "./sandbox-process.js";
import { SandboxFiles } from "./sandbox-files.js";

/** @internal */
export type SandboxWire = components["schemas"]["Sandbox"];

/** @internal */
export type SandboxExecWire = components["schemas"]["SandboxExec"];

export type SandboxStatus = components["schemas"]["SandboxState"];
export type SandboxExecStatus = components["schemas"]["SandboxExecState"];

export interface SandboxEndpoint {
  port: number;
  hostname: string;
}

export interface SandboxResponse {
  id: string;
  name: string;
  status: SandboxStatus;
  vcpuCount: number;
  memSizeMiB: number;
  baseImage: string;
  platform?: "arm64" | "amd64";
  maxTtlSeconds: number;
  /** Maximum concurrently attached exec sessions. Detached processes and one-shot controls do not count. */
  maxConcurrentExecs: number;
  endpoints?: SandboxEndpoint[];
  createdAt: Date;
  runningAt?: Date;
  finishedAt?: Date;
  lastActiveAt: Date;
  expiresAt?: Date;
  exitReason?: string;
}

export interface SandboxExecResponse {
  sandboxId: string;
  id: string;
  command: string;
  status: SandboxExecStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  exitReason?: string;
  executeTimeMs?: number;
  startedAt: Date;
  finishedAt?: Date;
}

export interface SandboxWaitOptions {
  /**
   * Wait for the operation to finish. Defaults to true.
   * The SDK polls if the server's wait budget expires first.
   */
  wait?: boolean;
}

export interface SandboxForkOptions extends SandboxWaitOptions {
  /** Name for the fork. The server generates one when omitted. */
  name?: string;
}

export interface SandboxConnectionInfo {
  url: string;
  expiresAt: Date;
}

export type SandboxExecOptions = {
  commandTty?: boolean;
  env?: Record<string, string>;
  timeoutSeconds?: number;
} & SandboxWaitOptions;

const POLL_INTERVAL_MS = 500;

function sleep(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

export class SandboxExec {
  sandboxId!: string;
  id!: string;
  command!: string;
  status!: SandboxExecStatus;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  exitReason?: string;
  executeTimeMs?: number;
  startedAt!: Date;
  finishedAt?: Date;

  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(data: SandboxExecWire, client: ApiClient) {
    this._client = client;
    this._apply(data);
  }

  /** @internal Overwrite this exec's fields in place from a fresh wire snapshot. */
  private _apply(data: SandboxExecWire): this {
    this.sandboxId = data.sandbox_id;
    this.id = data.exec_id;
    this.command = data.command;
    this.status = data.status;
    this.exitCode = data.exit_code;
    this.stdout = data.stdout;
    this.stderr = data.stderr;
    this.exitReason = data.exit_reason;
    this.executeTimeMs = data.execute_time_ms;
    this.startedAt = new Date(data.started_at);
    this.finishedAt = data.finished_at ? new Date(data.finished_at) : undefined;
    return this;
  }

  toJSON(): SandboxExecResponse {
    return {
      sandboxId: this.sandboxId,
      id: this.id,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      exitReason: this.exitReason,
      executeTimeMs: this.executeTimeMs,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  /** Re-fetch this exec and update it in place, returning the same object. */
  async refresh(): Promise<SandboxExec> {
    const data = await unwrap(
      this._client.GET("/api/sandboxes/{sid}/execs/{eid}", {
        params: { path: { sid: this.sandboxId, eid: this.id } },
      }),
    );
    return this._apply(data);
  }

  /** Cancel this exec and update it in place, returning the same object. */
  async cancel(): Promise<SandboxExec> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/execs/{eid}/cancel", {
        params: { path: { sid: this.sandboxId, eid: this.id } },
      }),
    );
    return this._apply(data);
  }
}

export class Sandbox {
  id!: string;
  name!: string;
  status!: SandboxStatus;
  vcpuCount!: number;
  memSizeMiB!: number;
  baseImage!: string;
  platform?: "arm64" | "amd64";
  maxTtlSeconds!: number;
  maxConcurrentExecs!: number;
  endpoints?: SandboxEndpoint[];
  createdAt!: Date;
  runningAt?: Date;
  finishedAt?: Date;
  lastActiveAt!: Date;
  expiresAt?: Date;
  exitReason?: string;
  readonly processes: SandboxProcesses;
  readonly files: SandboxFiles;

  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(data: SandboxWire, client: ApiClient) {
    this._client = client;
    this._apply(data);
    this.processes = new SandboxProcesses(this.id, client);
    this.files = new SandboxFiles(this.processes);
  }

  /** @internal Overwrite this sandbox's fields in place from a fresh wire snapshot. */
  private _apply(data: SandboxWire): this {
    this.id = data.sandbox_id;
    this.name = data.name;
    this.status = data.status;
    this.vcpuCount = data.vcpu_count;
    this.memSizeMiB = data.mem_size_mib;
    this.baseImage = data.base_image;
    this.platform = data.platform;
    this.maxTtlSeconds = data.max_ttl_seconds;
    this.maxConcurrentExecs = data.max_concurrent_execs;
    this.endpoints = data.endpoints?.map((endpoint) => ({ ...endpoint }));
    this.createdAt = new Date(data.created_at);
    this.runningAt = data.running_at ? new Date(data.running_at) : undefined;
    this.finishedAt = data.finished_at ? new Date(data.finished_at) : undefined;
    this.lastActiveAt = new Date(data.last_active_at);
    this.expiresAt = data.expires_at ? new Date(data.expires_at) : undefined;
    this.exitReason = data.exit_reason;
    return this;
  }

  toJSON(): SandboxResponse {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      vcpuCount: this.vcpuCount,
      memSizeMiB: this.memSizeMiB,
      baseImage: this.baseImage,
      platform: this.platform,
      maxTtlSeconds: this.maxTtlSeconds,
      maxConcurrentExecs: this.maxConcurrentExecs,
      endpoints: this.endpoints?.map((endpoint) => ({ ...endpoint })),
      createdAt: this.createdAt,
      runningAt: this.runningAt,
      finishedAt: this.finishedAt,
      lastActiveAt: this.lastActiveAt,
      expiresAt: this.expiresAt,
      exitReason: this.exitReason,
    };
  }

  /** Re-fetch this sandbox. */
  async refresh() {
    const data = await unwrap(
      this._client.GET("/api/sandboxes/{sid}", {
        params: { path: { sid: this.id } },
      }),
    );
    return this._apply(data);
  }

  /** Start this sandbox. */
  async start(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/start", {
        params: { path: { sid: this.id }, query: { wait: options.wait ?? true } },
      }),
    );
    this._apply(data);
    return options.wait === false ? this : waitForSandboxStart(this);
  }

  /** Stop this sandbox. */
  async stop(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/stop", {
        params: { path: { sid: this.id } },
      }),
    );
    this._apply(data);
    return options.wait === false ? this : waitWhileSandboxStatus(this, "stopping");
  }

  /** Pause this sandbox, preserving its CPU and memory state. */
  async pause(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/pause", {
        params: { path: { sid: this.id } },
      }),
    );
    this._apply(data);
    return options.wait === false ? this : waitWhileSandboxStatus(this, "pausing");
  }

  /** Resume this sandbox from its preserved CPU and memory state. */
  async resume(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/resume", {
        params: { path: { sid: this.id }, query: { wait: options.wait ?? true } },
      }),
    );
    this._apply(data);
    return options.wait === false ? this : waitForSandboxStart(this);
  }

  /** Create an isolated writable branch from this sandbox's current state. */
  async fork(options: SandboxForkOptions = {}): Promise<Sandbox> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/fork", {
        params: { path: { sid: this.id }, query: { wait: options.wait ?? true } },
        body: options.name === undefined ? undefined : { name: options.name },
      }),
    );
    const fork = new Sandbox(data, this._client);
    return options.wait === false ? fork : waitForSandboxStart(fork);
  }

  /** Create a short-lived signed WebSocket URL for a sandbox process connection. */
  async createConnection(): Promise<SandboxConnectionInfo> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/connections", {
        params: { path: { sid: this.id } },
      }),
    );
    return { url: data.url, expiresAt: new Date(data.expires_at) };
  }

  /** Delete this sandbox and its backing disk. */
  async delete(): Promise<void> {
    await unwrapEmpty(
      this._client.DELETE("/api/sandboxes/{sid}", {
        params: { path: { sid: this.id } },
      }),
    );
  }

  async exec(
    command: string,
    options: SandboxExecOptions = {},
  ): Promise<SandboxExec> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/execs", {
        params: {
          path: { sid: this.id },
          query: { wait: options.wait ?? true },
        },
        body: {
          command,
          command_tty: options.commandTty,
          env: options.env,
          timeout_seconds: options.timeoutSeconds,
        },
      }),
    );
    const exec = new SandboxExec(data, this._client);
    if (options.wait === false) return exec;

    while (exec.status === "running") {
      await sleep();
      await exec.refresh();
    }
    return exec;
  }

  async listExecs(): Promise<SandboxExec[]> {
    const data = await unwrap(
      this._client.GET("/api/sandboxes/{sid}/execs", {
        params: { path: { sid: this.id } },
      }),
    );
    return ((data as { execs?: SandboxExecWire[] } | null)?.execs ?? []).map(
      (exec) => new SandboxExec(exec, this._client),
    );
  }

  async getExec(execId: string): Promise<SandboxExec> {
    const data = await unwrap(
      this._client.GET("/api/sandboxes/{sid}/execs/{eid}", {
        params: { path: { sid: this.id, eid: execId } },
      }),
    );
    return new SandboxExec(data, this._client);
  }

  async cancelExec(execId: string): Promise<SandboxExec> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/execs/{eid}/cancel", {
        params: { path: { sid: this.id, eid: execId } },
      }),
    );
    return new SandboxExec(data, this._client);
  }
}

/** @internal Continue waiting if the server returned before startup completed. */
export async function waitForSandboxStart(sandbox: Sandbox): Promise<Sandbox> {
  return waitWhileSandboxStatus(sandbox, "pending");
}

async function waitWhileSandboxStatus(
  sandbox: Sandbox,
  status: SandboxStatus,
): Promise<Sandbox> {
  while (sandbox.status === status) {
    await sleep();
    await sandbox.refresh();
  }
  return sandbox;
}
