import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import { ArchilError } from "./errors.js";

type GeneratedSandbox = components["schemas"]["Sandbox"];

/** @internal */
export type SandboxWire = Omit<GeneratedSandbox, "port_mappings"> & {
  endpoints?: Array<{ port: number; hostname: string }>;
};

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
  status: SandboxStatus;
  vcpuCount: number;
  memSizeMiB: number;
  maxTtlSeconds: number;
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

export type WaitForStartOptions =
  | { waitForStart?: true; waitUpToMs?: number }
  | { waitForStart: false; waitUpToMs?: never };

export type WaitForStopOptions =
  | { waitForStop?: true; waitUpToMs?: number }
  | { waitForStop: false; waitUpToMs?: never };

export type WaitForCompletionOptions =
  | { waitForCompletion?: true; waitUpToMs?: number }
  | { waitForCompletion: false; waitUpToMs?: never };

export type SandboxExecOptions = {
  commandTty?: boolean;
  env?: Record<string, string>;
  timeoutSeconds?: number;
} & WaitForCompletionOptions;

/** @internal */
export const DEFAULT_SANDBOX_WAIT_UP_TO_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/** @internal */
export function validateWaitUpToMs(waitUpToMs: number): void {
  if (!Number.isFinite(waitUpToMs) || waitUpToMs < 0) {
    throw new RangeError("waitUpToMs must be a finite, non-negative number");
  }
}

/**
 * The requested SDK-side wait expired. The remote sandbox operation continues;
 * `latest` is the same `Sandbox`/`SandboxExec` the operation was called on,
 * updated in place to the last state observed before the deadline.
 */
export class SandboxWaitTimeoutError extends ArchilError {
  readonly operation: "start" | "stop" | "exec";
  readonly timeoutMs: number;
  readonly latest: Sandbox | SandboxExec;

  constructor(operation: "start" | "stop" | "exec", timeoutMs: number, latest: Sandbox | SandboxExec) {
    const subject = operation === "exec" ? "sandbox exec to complete" : `sandbox to ${operation}`;
    super(`Timed out after ${timeoutMs}ms waiting for ${subject}`, 408, "SANDBOX_WAIT_TIMEOUT");
    this.name = "SandboxWaitTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.latest = latest;
  }
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
    return this._apply(data as SandboxExecWire);
  }

  /** Cancel this exec and update it in place, returning the same object. */
  async cancel(): Promise<SandboxExec> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/execs/{eid}/cancel", {
        params: { path: { sid: this.sandboxId, eid: this.id } },
      }),
    );
    return this._apply(data as SandboxExecWire);
  }
}

export class Sandbox {
  id!: string;
  status!: SandboxStatus;
  vcpuCount!: number;
  memSizeMiB!: number;
  maxTtlSeconds!: number;
  maxConcurrentExecs!: number;
  endpoints?: SandboxEndpoint[];
  createdAt!: Date;
  runningAt?: Date;
  finishedAt?: Date;
  lastActiveAt!: Date;
  expiresAt?: Date;
  exitReason?: string;

  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(data: SandboxWire, client: ApiClient) {
    this._client = client;
    this._apply(data);
  }

  /** @internal Overwrite this sandbox's fields in place from a fresh wire snapshot. */
  private _apply(data: SandboxWire): this {
    this.id = data.sandbox_id;
    this.status = data.status;
    this.vcpuCount = data.vcpu_count;
    this.memSizeMiB = data.mem_size_mib;
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
      status: this.status,
      vcpuCount: this.vcpuCount,
      memSizeMiB: this.memSizeMiB,
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

  /** Re-fetch this sandbox and update it in place, returning the same object. */
  async refresh(): Promise<Sandbox> {
    const data = await unwrap(
      this._client.GET("/api/sandboxes/{sid}", {
        params: { path: { sid: this.id } },
      }),
    );
    return this._apply(data as SandboxWire);
  }

  /** Start this sandbox and update it in place, returning the same object. */
  async start(options: WaitForStartOptions = {}): Promise<Sandbox> {
    const waitForStart = options.waitForStart ?? true;
    const waitUpToMs = options.waitUpToMs ?? DEFAULT_SANDBOX_WAIT_UP_TO_MS;
    if (waitForStart) validateWaitUpToMs(waitUpToMs);
    const deadline = Date.now() + waitUpToMs;

    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/start", {
        params: { path: { sid: this.id }, query: { wait: waitForStart } },
      }),
    );
    this._apply(data as SandboxWire);
    return waitForStart ? waitForSandboxStart(this, deadline, waitUpToMs) : this;
  }

  /** Stop this sandbox and update it in place, returning the same object. */
  async stop(options: WaitForStopOptions = {}): Promise<Sandbox> {
    const waitForStop = options.waitForStop ?? true;
    const waitUpToMs = options.waitUpToMs ?? DEFAULT_SANDBOX_WAIT_UP_TO_MS;
    if (waitForStop) validateWaitUpToMs(waitUpToMs);
    const deadline = Date.now() + waitUpToMs;

    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/stop", {
        params: { path: { sid: this.id } },
      }),
    );
    this._apply(data as SandboxWire);
    if (!waitForStop) return this;

    for (;;) {
      if (["stopped", "exited", "failed"].includes(this.status)) return this;
      if (this.status !== "stopping") {
        throw new ArchilError(
          `Sandbox entered ${this.status} before it stopped`,
          409,
          "SANDBOX_STOP_FAILED",
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SandboxWaitTimeoutError("stop", waitUpToMs, this);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
      await this.refresh();
    }
  }

  async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExec> {
    const waitForCompletion = options.waitForCompletion ?? true;
    const waitUpToMs = options.waitUpToMs ?? DEFAULT_SANDBOX_WAIT_UP_TO_MS;
    if (waitForCompletion) validateWaitUpToMs(waitUpToMs);
    const deadline = Date.now() + waitUpToMs;

    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/execs", {
        params: {
          path: { sid: this.id },
          query: { wait: waitForCompletion },
        },
        body: {
          command,
          command_tty: options.commandTty,
          env: options.env,
          timeout_seconds: options.timeoutSeconds,
        },
      }),
    );
    const exec = new SandboxExec(data as SandboxExecWire, this._client);
    if (!waitForCompletion || exec.status !== "running") return exec;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SandboxWaitTimeoutError("exec", waitUpToMs, exec);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
      await exec.refresh();
      if (exec.status !== "running") return exec;
    }
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
    return new SandboxExec(data as SandboxExecWire, this._client);
  }

  async cancelExec(execId: string): Promise<SandboxExec> {
    const data = await unwrap(
      this._client.POST("/api/sandboxes/{sid}/execs/{eid}/cancel", {
        params: { path: { sid: this.id, eid: execId } },
      }),
    );
    return new SandboxExec(data as SandboxExecWire, this._client);
  }
}

/** @internal Poll `sandbox` in place until it is running (or the deadline passes). */
export async function waitForSandboxStart(
  sandbox: Sandbox,
  deadline: number,
  timeoutMs: number,
): Promise<Sandbox> {
  for (;;) {
    if (sandbox.status === "running") return sandbox;
    if (sandbox.status !== "pending") {
      const detail = sandbox.exitReason ? `: ${sandbox.exitReason}` : "";
      throw new ArchilError(
        `Sandbox entered ${sandbox.status} before it started${detail}`,
        409,
        "SANDBOX_START_FAILED",
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SandboxWaitTimeoutError("start", timeoutMs, sandbox);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    await sandbox.refresh();
  }
}
