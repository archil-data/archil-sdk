import { type ApiClient, unwrap } from "./client.js";
import { ArchilError, ArchilTimeoutError } from "./errors.js";
import type {
  SandboxExecRequest,
  SandboxExecResponse,
  SandboxExecState,
  SandboxPortMapping,
  SandboxResponse,
  SandboxState,
} from "./types.js";

export type SandboxStatus = SandboxState;
export type SandboxExecStatus = SandboxExecState;

export interface SandboxPort {
  /** Port the guest listens on. */
  port: SandboxPortMapping["container_port"];
  /** Defaults to "tcp". */
  protocol?: SandboxPortMapping["protocol"];
}

export interface SandboxResources {
  vcpus?: SandboxResponse["vcpu_count"];
  memoryMiB?: SandboxResponse["mem_size_mib"];
}

export interface SandboxInfo {
  id: string;
  status: SandboxStatus;
  ports: Required<SandboxPort>[];
  resources: Required<SandboxResources>;
  maxTtlSeconds: number;
  maxConcurrentExecs: number;
  createdAt: Date;
  runningAt?: Date;
  finishedAt?: Date;
  lastActiveAt: Date;
  /** Deadline of the current powered-on session; absent while inactive. */
  expiresAt?: Date;
  exitReason?: string;
}

/** Result of a finished sandbox exec. */
export interface SandboxExecResult {
  execId: string;
  command: string;
  status: SandboxExecStatus;
  /** Null when the command never ran to completion (e.g. cancelled). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  exitReason?: string;
  executeTimeMs?: number;
  startedAt: Date;
  finishedAt?: Date;
}

export interface SandboxWaitOptions {
  /** Wait for the target state before resolving. Defaults to true. */
  wait?: boolean;
  /** Deadline for the wait in milliseconds. Defaults to 120000. */
  waitTimeoutMs?: number;
  /** Base interval between status polls in milliseconds. Defaults to 50. */
  pollIntervalMs?: number;
}

export interface SandboxRunOptions {
  /** Extra environment variables for this command. */
  env?: SandboxExecRequest["env"];
  /** Allocate a TTY for the command. Defaults to false. */
  tty?: boolean;
  /**
   * Server-side execution timeout in milliseconds. The client also stops
   * polling (and throws ArchilTimeoutError) shortly after this deadline.
   * When omitted, polls until the exec finishes or the sandbox session ends.
   */
  timeoutMs?: number;
  /** Base interval between result polls in milliseconds. Defaults to 50. */
  pollIntervalMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 2_000;

const INACTIVE_STATUSES: ReadonlySet<SandboxStatus> = new Set(["stopped", "exited", "failed"]);
const TERMINAL_EXEC_STATUSES: ReadonlySet<SandboxExecStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function toSandboxInfo(response: SandboxResponse): SandboxInfo {
  return {
    id: response.sandbox_id,
    status: response.status,
    ports: (response.port_mappings ?? []).map((port) => ({
      port: port.container_port,
      protocol: port.protocol,
    })),
    resources: { vcpus: response.vcpu_count, memoryMiB: response.mem_size_mib },
    maxTtlSeconds: response.max_ttl_seconds,
    maxConcurrentExecs: response.max_concurrent_execs,
    createdAt: new Date(response.created_at),
    runningAt: response.running_at ? new Date(response.running_at) : undefined,
    finishedAt: response.finished_at ? new Date(response.finished_at) : undefined,
    lastActiveAt: new Date(response.last_active_at),
    expiresAt: response.expires_at ? new Date(response.expires_at) : undefined,
    exitReason: response.exit_reason,
  };
}

function toExecResult(response: SandboxExecResponse): SandboxExecResult {
  return {
    execId: response.exec_id,
    command: response.command,
    status: response.status,
    exitCode: response.exit_code ?? null,
    stdout: response.stdout ?? "",
    stderr: response.stderr ?? "",
    exitReason: response.exit_reason,
    executeTimeMs: response.execute_time_ms,
    startedAt: new Date(response.started_at),
    finishedAt: response.finished_at ? new Date(response.finished_at) : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransportError(error: unknown): boolean {
  return !(error instanceof ArchilError);
}

function timeoutSignal(deadline: number | undefined): AbortSignal | undefined {
  return deadline === undefined
    ? undefined
    : AbortSignal.timeout(Math.max(deadline - Date.now(), 1));
}

/**
 * A handle to one sandbox: a long-lived microVM with a persistent root disk.
 * Obtain instances from `archil.sandbox.create()`, `.get()`, `.list()`, or
 * `.start()`; the handle caches the sandbox's last observed state (`info`,
 * `status`) and `refresh()` re-fetches it.
 */
export class Sandbox {
  /** @internal */
  private readonly _client: ApiClient;
  /** @internal */
  private _info: SandboxInfo;

  /** @internal */
  constructor(client: ApiClient, info: SandboxInfo) {
    this._client = client;
    this._info = info;
  }

  get id(): string {
    return this._info.id;
  }

  /** Status as of the last API response; call refresh() for a current view. */
  get status(): SandboxStatus {
    return this._info.status;
  }

  get info(): SandboxInfo {
    return this._info;
  }

  async refresh(): Promise<this> {
    const response = await unwrap<SandboxResponse>(
      this._client.GET("/api/sandboxes/{sid}", { params: { path: { sid: this.id } } }),
    );
    this._info = toSandboxInfo(response);
    return this;
  }

  /**
   * Run a shell command in the sandbox and wait for it to finish. A non-zero
   * exit code is reported in the result, not thrown.
   */
  async run(command: string, opts: SandboxRunOptions = {}): Promise<SandboxExecResult> {
    const body: SandboxExecRequest = {
      command,
      ...(opts.tty && { command_tty: true }),
      ...(opts.env !== undefined && { env: opts.env }),
      ...(opts.timeoutMs !== undefined && {
        timeout_seconds: Math.ceil(opts.timeoutMs / 1000),
      }),
    };
    let response = await unwrap<SandboxExecResponse>(
      this._client.POST("/api/sandboxes/{sid}/execs", {
        params: { path: { sid: this.id }, query: { wait: true } },
        body,
      }),
    );
    const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs + 30_000 : undefined;
    let interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (!TERMINAL_EXEC_STATUSES.has(response.status)) {
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new ArchilTimeoutError(
          `Timed out waiting for exec ${response.exec_id} on sandbox ${this.id}`,
        );
      }
      await sleep(interval);
      interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
      try {
        response = await unwrap<SandboxExecResponse>(
          this._client.GET("/api/sandboxes/{sid}/execs/{eid}", {
            params: { path: { sid: this.id, eid: response.exec_id } },
            signal: timeoutSignal(deadline),
          }),
        );
      } catch (error) {
        if (!isTransportError(error)) throw error;
      }
    }

    return toExecResult(response);
  }

  /**
   * Cold-boot a stopped sandbox from its persisted configuration and disk.
   * By default waits until the sandbox is running.
   */
  async start(opts: SandboxWaitOptions = {}): Promise<this> {
    const response = await unwrap<SandboxResponse>(
      this._client.POST("/api/sandboxes/{sid}/start", {
        params: { path: { sid: this.id }, query: { wait: opts.wait ?? true } },
      }),
    );
    this._info = toSandboxInfo(response);
    if (opts.wait ?? true) {
      await this.waitUntilRunning(opts);
    }
    return this;
  }

  /**
   * Stop the sandbox without a memory snapshot. Disk state persists; a later
   * {@link start} cold-boots. By default waits until the sandbox is stopped.
   */
  async stop(opts: SandboxWaitOptions = {}): Promise<this> {
    const response = await unwrap<SandboxResponse>(
      this._client.POST("/api/sandboxes/{sid}/stop", {
        params: { path: { sid: this.id } },
      }),
    );
    this._info = toSandboxInfo(response);
    if (opts.wait ?? true) {
      await this.waitUntil(this.stoppedCleanly("stop"), opts, "stop");
    }
    return this;
  }

  /**
   * Poll until the sandbox is running. Throws ArchilError if it lands in a
   * non-startable state and ArchilTimeoutError past the deadline.
   */
  async waitUntilRunning(opts: Omit<SandboxWaitOptions, "wait"> = {}): Promise<this> {
    return this.waitUntil(
      (status) => {
        if (INACTIVE_STATUSES.has(status)) {
          const reason = this._info.exitReason ? `: ${this._info.exitReason}` : "";
          throw new ArchilError(`Sandbox ${this.id} is ${status}${reason}`, 409);
        }
        return status === "running";
      },
      opts,
      "be running",
    );
  }

  private stoppedCleanly(operation: string): (status: SandboxStatus) => boolean {
    return (status) => {
      if (status === "failed") {
        const reason = this._info.exitReason ? `: ${this._info.exitReason}` : "";
        throw new ArchilError(`Sandbox ${this.id} failed during ${operation}${reason}`, 409);
      }
      return INACTIVE_STATUSES.has(status);
    };
  }

  private async waitUntil(
    done: (status: SandboxStatus) => boolean,
    opts: Omit<SandboxWaitOptions, "wait">,
    what: string,
  ): Promise<this> {
    const deadline = Date.now() + (opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    let interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (!done(this._info.status)) {
      if (Date.now() >= deadline) {
        throw new ArchilTimeoutError(`Timed out waiting for sandbox ${this.id} to ${what}`);
      }
      try {
        const response = await unwrap<SandboxResponse>(
          this._client.GET("/api/sandboxes/{sid}", {
            params: { path: { sid: this.id } },
            signal: timeoutSignal(deadline),
          }),
        );
        this._info = toSandboxInfo(response);
      } catch (error) {
        if (!isTransportError(error)) throw error;
      }
      if (!done(this._info.status)) {
        await sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)));
        interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
      }
    }

    return this;
  }
}
