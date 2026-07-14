import type { Client } from "openapi-fetch";
import { unwrap } from "./client.js";
import { ArchilError, ArchilTimeoutError } from "./errors.js";
import type {
  SandboxApiPaths,
  SandboxExecStatusWire,
  SandboxExecWire,
  SandboxStatusWire,
  SandboxWire,
} from "./sandbox-api.js";

export type SandboxApiClient = Client<SandboxApiPaths>;

export type SandboxStatus = SandboxStatusWire;
export type SandboxExecStatus = SandboxExecStatusWire;

export interface SandboxPort {
  /** Port the guest listens on. */
  port: number;
  /** Defaults to "tcp". */
  protocol?: "tcp" | "udp";
}

export interface SandboxResources {
  vcpus?: number;
  memoryMiB?: number;
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
  /** Base interval between status polls in milliseconds. Defaults to 500. */
  pollIntervalMs?: number;
}

export interface SandboxRunOptions {
  /** Extra environment variables for this command. */
  env?: Record<string, string>;
  /** Allocate a TTY for the command. Defaults to false. */
  tty?: boolean;
  /**
   * Server-side execution timeout in milliseconds. The client also stops
   * polling (and throws ArchilTimeoutError) shortly after this deadline.
   * When omitted, polls until the exec finishes or the sandbox session ends.
   */
  timeoutMs?: number;
  /** Base interval between result polls in milliseconds. Defaults to 500. */
  pollIntervalMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 2_000;

const INACTIVE_STATUSES: ReadonlySet<SandboxStatus> = new Set(["stopped", "exited", "failed"]);
const TERMINAL_EXEC_STATUSES: ReadonlySet<SandboxExecStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function toSandboxInfo(w: SandboxWire): SandboxInfo {
  return {
    id: w.sandbox_id,
    status: w.status,
    ports: (w.port_mappings ?? []).map((p) => ({ port: p.container_port, protocol: p.protocol })),
    resources: { vcpus: w.vcpu_count, memoryMiB: w.mem_size_mib },
    maxTtlSeconds: w.max_ttl_seconds,
    maxConcurrentExecs: w.max_concurrent_execs,
    createdAt: new Date(w.created_at),
    runningAt: w.running_at ? new Date(w.running_at) : undefined,
    finishedAt: w.finished_at ? new Date(w.finished_at) : undefined,
    lastActiveAt: new Date(w.last_active_at),
    expiresAt: w.expires_at ? new Date(w.expires_at) : undefined,
    exitReason: w.exit_reason,
  };
}

function toExecResult(w: SandboxExecWire): SandboxExecResult {
  return {
    execId: w.exec_id,
    command: w.command,
    status: w.status,
    exitCode: w.exit_code ?? null,
    stdout: w.stdout ?? "",
    stderr: w.stderr ?? "",
    exitReason: w.exit_reason,
    executeTimeMs: w.execute_time_ms,
    startedAt: new Date(w.started_at),
    finishedAt: w.finished_at ? new Date(w.finished_at) : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A handle to one sandbox: a long-lived microVM that runs commands with
 * Archil disks mounted. Obtain instances from `archil.sandbox.create()`,
 * `.get()`, `.list()`, or `.start()`; the handle caches the sandbox's last
 * observed state (`info`, `status`) and `refresh()` re-fetches it.
 */
export class Sandbox {
  /** @internal */
  private readonly _client: SandboxApiClient;
  /** @internal */
  private _info: SandboxInfo;

  /** @internal */
  constructor(client: SandboxApiClient, info: SandboxInfo) {
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
    const wire = await unwrap<SandboxWire>(
      this._client.GET("/api/sandboxes/{sid}", { params: { path: { sid: this.id } } }),
    );
    this._info = toSandboxInfo(wire);
    return this;
  }

  /**
   * Run a shell command in the sandbox and wait for it to finish. A non-zero
   * exit code is reported in the result, not thrown.
   */
  async run(command: string, opts: SandboxRunOptions = {}): Promise<SandboxExecResult> {
    const submitted = await unwrap<SandboxExecWire>(
      this._client.POST("/api/sandboxes/{sid}/execs", {
        params: { path: { sid: this.id } },
        body: {
          command,
          ...(opts.tty && { command_tty: true }),
          ...(opts.env !== undefined && { env: opts.env }),
          ...(opts.timeoutMs !== undefined && {
            timeout_seconds: Math.ceil(opts.timeoutMs / 1000),
          }),
        },
      }),
    );
    // Grace past the server-side deadline so the server's timed_out result
    // (which is authoritative) is normally observed before the client bails.
    const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs + 30_000 : undefined;
    let interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      const wire = await unwrap<SandboxExecWire>(
        this._client.GET("/api/sandboxes/{sid}/execs/{eid}", {
          params: { path: { sid: this.id, eid: submitted.exec_id } },
        }),
      );
      if (TERMINAL_EXEC_STATUSES.has(wire.status)) {
        return toExecResult(wire);
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new ArchilTimeoutError(
          `Timed out waiting for exec ${submitted.exec_id} on sandbox ${this.id}`,
        );
      }
      await sleep(interval);
      interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
    }
  }

  /**
   * Start (or resume) a stopped sandbox. Resumes from a memory snapshot when
   * one is available, else cold-boots from the sandbox's persisted
   * configuration. By default waits until the sandbox is running.
   */
  async start(opts: SandboxWaitOptions = {}): Promise<this> {
    const wire = await unwrap<SandboxWire>(
      this._client.POST("/api/sandboxes/{sid}/start", { params: { path: { sid: this.id } } }),
    );
    this._info = toSandboxInfo(wire);
    if (opts.wait ?? true) {
      await this.waitUntilRunning(opts);
    }
    return this;
  }

  /**
   * Stop the sandbox, keeping it resumable via {@link start} (the runtime
   * saves a memory snapshot when the sandbox is idle). By default waits until
   * the sandbox is fully stopped.
   */
  async stop(opts: SandboxWaitOptions = {}): Promise<this> {
    const wire = await unwrap<SandboxWire>(
      this._client.POST("/api/sandboxes/{sid}/stop", { params: { path: { sid: this.id } } }),
    );
    this._info = toSandboxInfo(wire);
    if (opts.wait ?? true) {
      await this.waitUntil((status) => INACTIVE_STATUSES.has(status), opts, "stop");
    }
    return this;
  }

  /**
   * Poll until the sandbox is running. Throws ArchilError if it lands in a
   * non-startable state (exited/failed/stopped) instead, and
   * ArchilTimeoutError past the deadline.
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

  /** @internal */
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
      await sleep(interval);
      interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
      await this.refresh();
    }
    return this;
  }
}
