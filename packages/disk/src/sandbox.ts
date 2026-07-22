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
  /** Base interval between status polls in milliseconds. Defaults to 50. */
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
  /** Base interval between result polls in milliseconds. Defaults to 50. */
  pollIntervalMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
// Polling is the fallback (the CP usually answers with the final state): start fast, back off toward the cap.
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 2_000;
// Server caps wait_timeout_ms at 30s; stay under it and under LB idle timeouts.
const MAX_WAIT_HOLD_MS = 25_000;
const ABORT_MARGIN_MS = 10_000;

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

// A held GET is idempotent, so anything that died in transit (our abort, a
// dropped connection) is simply reissued; only real API answers propagate.
function isTransportError(e: unknown): boolean {
  return !(e instanceof ArchilError);
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
    let wire = submitted;
    for (;;) {
      if (TERMINAL_EXEC_STATUSES.has(wire.status)) {
        return toExecResult(wire);
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new ArchilTimeoutError(
          `Timed out waiting for exec ${submitted.exec_id} on sandbox ${this.id}`,
        );
      }
      // Held GET (wait_timeout_ms): one idempotent request per hold window, safe
      // to abort and reissue. Fallback pacing for servers without the param.
      const holdMs = Math.min(
        deadline !== undefined ? Math.max(deadline - Date.now(), 1) : MAX_WAIT_HOLD_MS,
        MAX_WAIT_HOLD_MS,
      );
      const sent = Date.now();
      try {
        wire = await unwrap<SandboxExecWire>(
          this._client.GET("/api/sandboxes/{sid}/execs/{eid}", {
            params: {
              path: { sid: this.id, eid: submitted.exec_id },
              query: { wait_timeout_ms: holdMs },
            },
            signal: AbortSignal.timeout(holdMs + ABORT_MARGIN_MS),
          } as Parameters<typeof this._client.GET>[1]),
        );
      } catch (e) {
        if (!isTransportError(e)) throw e;
        await sleep(interval);
        continue;
      }
      if (!TERMINAL_EXEC_STATUSES.has(wire.status) && Date.now() - sent < 1_000) {
        await sleep(interval);
        interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
      }
    }
  }

  /**
   * Cold-boot a stopped sandbox from its persisted configuration and disks.
   * RAM and process state are not restored — use {@link resume} for that.
   * By default waits until the sandbox is running.
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
   * Stop the sandbox without a memory snapshot. Disk state persists; a later
   * {@link start} cold-boots. By default waits until the sandbox is stopped.
   */
  async stop(opts: SandboxWaitOptions = {}): Promise<this> {
    const wire = await unwrap<SandboxWire>(
      this._client.POST("/api/sandboxes/{sid}/stop", { params: { path: { sid: this.id } } }),
    );
    this._info = toSandboxInfo(wire);
    if (opts.wait ?? true) {
      await this.waitUntil(this._stoppedCleanly("stop"), opts, "stop", "stopped");
    }
    return this;
  }

  /**
   * Pause the sandbox: snapshot guest memory (RAM, processes, sockets) onto
   * the sandbox's disk and stop the VM. {@link resume} continues where the
   * guest paused. By default waits until the sandbox is stopped.
   */
  async pause(opts: SandboxWaitOptions = {}): Promise<this> {
    // Path cast until @archildata/api-types ships the pause/resume routes.
    const wire = await unwrap<SandboxWire>(
      this._client.POST("/api/sandboxes/{sid}/pause" as "/api/sandboxes/{sid}/stop", {
        params: { path: { sid: this.id } },
      }),
    );
    this._info = toSandboxInfo(wire);
    if (opts.wait ?? true) {
      await this.waitUntil(this._stoppedCleanly("pause"), opts, "pause", "stopped");
    }
    return this;
  }

  /**
   * @internal "Failed" is inactive but it is not a successful stop/pause —
   * resolving on it hid real failures (e.g. a snapshot that never committed).
   */
  private _stoppedCleanly(what: string): (status: SandboxStatus) => boolean {
    return (status) => {
      if (status === "failed") {
        const reason = this._info.exitReason ? `: ${this._info.exitReason}` : "";
        throw new ArchilError(`Sandbox ${this.id} failed during ${what}${reason}`, 409);
      }
      return INACTIVE_STATUSES.has(status);
    };
  }

  /**
   * Resume a paused sandbox from its memory snapshot — the guest continues
   * exactly where {@link pause} froze it (falls back to a cold boot when no
   * snapshot exists). By default waits until the sandbox is running.
   */
  async resume(opts: SandboxWaitOptions = {}): Promise<this> {
    const wire = await unwrap<SandboxWire>(
      this._client.POST("/api/sandboxes/{sid}/resume" as "/api/sandboxes/{sid}/start", {
        params: { path: { sid: this.id } },
      }),
    );
    this._info = toSandboxInfo(wire);
    if (opts.wait ?? true) {
      await this.waitUntilRunning(opts);
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
      "running",
    );
  }

  /**
   * @internal Long-polls: each GET asks the server to hold until `target` is
   * reached (wait_status), so a status change comes back in one round-trip. A
   * server without wait support answers immediately; those fall back to
   * client-side pacing. The abort margin bounds a stalled connection instead
   * of leaving it to TCP timeouts.
   */
  private async waitUntil(
    done: (status: SandboxStatus) => boolean,
    opts: Omit<SandboxWaitOptions, "wait">,
    what: string,
    target: SandboxStatus,
  ): Promise<this> {
    const deadline = Date.now() + (opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    let interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    while (!done(this._info.status)) {
      if (Date.now() >= deadline) {
        throw new ArchilTimeoutError(`Timed out waiting for sandbox ${this.id} to ${what}`);
      }
      const holdMs = Math.min(deadline - Date.now(), MAX_WAIT_HOLD_MS);
      const sent = Date.now();
      let wire: SandboxWire;
      try {
        wire = await unwrap<SandboxWire>(
          this._client.GET("/api/sandboxes/{sid}", {
            params: {
              path: { sid: this.id },
              query: { wait_status: target, wait_timeout_ms: holdMs },
            },
            signal: AbortSignal.timeout(holdMs + ABORT_MARGIN_MS),
          } as Parameters<typeof this._client.GET>[1]),
        );
      } catch (e) {
        if (!isTransportError(e)) throw e;
        await sleep(interval);
        continue;
      }
      this._info = toSandboxInfo(wire);
      if (!done(this._info.status) && Date.now() - sent < 1_000) {
        await sleep(interval);
        interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
      }
    }
    return this;
  }
}
