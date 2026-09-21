import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap, unwrapEmpty, unwrapPage } from "./client.js";
import {
  SandboxProcess,
  openProcessSocket,
  type ProcessControlRequest,
  type SandboxProcessConnectOptions,
  type SandboxProcessResult,
  type SandboxProcessStartOptions,
} from "./sandbox-process.js";
import { SandboxFiles } from "./sandbox-files.js";
import { retryApiRequest } from "./retry.js";

export type SandboxNetworkAction = components["schemas"]["SandboxNetworkAction"];

export type SandboxEgressPolicy = components["schemas"]["SandboxEgressPolicy"];

export type SandboxEgressRule = components["schemas"]["SandboxEgressRule"];

export type SandboxEgressTransform = components["schemas"]["SandboxEgressTransform"];

export type SandboxNetwork = components["schemas"]["SandboxNetwork"];

/** @internal */
export type SandboxWire = components["schemas"]["Sandbox"] & {
  idle_ttl_seconds?: number;
};

export type SandboxStatus = components["schemas"]["SandboxState"];

export interface SandboxEndpoint {
  port: number;
  hostname: string;
}

/** Port-token metadata. The secret and hostname are returned only on creation. */
export interface SandboxPortToken {
  id: string;
  port: number;
  createdAt: Date;
  expiresAt?: Date;
}

export interface CreatedSandboxPortToken extends SandboxPortToken {
  hostname: string;
  /** Send in X-Archil-Token. Save it now; it cannot be retrieved again. */
  token: string;
}

export interface CreateSandboxPortTokenOptions {
  /** Duration such as "1h" or "30m", up to "8760h" (365 days). Omit for no expiration. */
  ttl?: string;
}

export interface ListSandboxPortTokensOptions {
  limit?: number;
  cursor?: string;
}

export interface SandboxPortTokenPage {
  tokens: SandboxPortToken[];
  nextCursor?: string;
}

function portTokenFromWire(data: components["schemas"]["SandboxPortToken"]): SandboxPortToken {
  return {
    id: data.id,
    port: data.port,
    createdAt: new Date(data.created_at),
    expiresAt: data.expires_at ? new Date(data.expires_at) : undefined,
  };
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
  idleTtlSeconds: number;
  /** Maximum concurrently attached process sessions. Detached processes and one-shot controls do not count. */
  maxConcurrentExecs: number;
  endpoints?: SandboxEndpoint[];
  createdAt: Date;
  runningAt?: Date;
  finishedAt?: Date;
  lastActiveAt: Date;
  exitReason?: string;
  /** Disk checkpoint the current session leaves behind; present while pausing, paused, stopping, or stopped. */
  checkpoint?: string;
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

export interface SandboxTimeoutOptions {
  /** Hard lifetime in seconds. Omit to leave its deadline unchanged. */
  timeoutSeconds?: number;
  /** Seconds without a direct process connection. Zero disables idle expiry; omit to leave unchanged. */
  idleTtlSeconds?: number;
}

type SandboxExtensionClient = {
  GET(
    path: "/api/sandboxes/{sid}/ports",
    options: { params: { path: { sid: string } } },
  ): Promise<{
    data?: { success: boolean; data?: { ports: SandboxEndpoint[] }; error?: string };
    error?: unknown;
    response: Response;
  }>;
  PUT(
    path: "/api/sandboxes/{sid}/ports/{port}",
    options: { params: { path: { sid: string; port: number } } },
  ): Promise<{
    data?: { success: boolean; data?: SandboxEndpoint; error?: string };
    error?: unknown;
    response: Response;
  }>;
  DELETE(
    path: "/api/sandboxes/{sid}/ports/{port}",
    options: { params: { path: { sid: string; port: number } } },
  ): Promise<{ error?: unknown; response: Response }>;
  GET(
    path: "/api/sandboxes/{sid}/network",
    options: { params: { path: { sid: string } } },
  ): Promise<{
    data?: { success: boolean; data?: SandboxNetwork; error?: string };
    error?: unknown;
    response: Response;
  }>;
  PUT(
    path: "/api/sandboxes/{sid}/network",
    options: { params: { path: { sid: string } }; body: SandboxNetwork },
  ): Promise<{
    data?: { success: boolean; data?: SandboxNetwork; error?: string };
    error?: unknown;
    response: Response;
  }>;
  POST(
    path: "/api/sandboxes/{sid}/timeout",
    options: {
      params: { path: { sid: string } };
      body: { timeout?: number; idle_ttl_seconds?: number };
    },
  ): Promise<{
    data?: { success: boolean; data?: SandboxWire; error?: string };
    error?: unknown;
    response: Response;
  }>;
};

const POLL_INTERVAL_MS = 500;

function sleep(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
  idleTtlSeconds!: number;
  maxConcurrentExecs!: number;
  endpoints?: SandboxEndpoint[];
  createdAt!: Date;
  runningAt?: Date;
  finishedAt?: Date;
  lastActiveAt!: Date;
  exitReason?: string;
  checkpoint?: string;
  readonly files: SandboxFiles;

  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(data: SandboxWire, client: ApiClient) {
    this._client = client;
    this._apply(data);
    this.files = new SandboxFiles(this);
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
    this.idleTtlSeconds = data.idle_ttl_seconds ?? 0;
    this.maxConcurrentExecs = data.max_concurrent_execs;
    this.endpoints = data.endpoints?.map((endpoint) => ({ ...endpoint }));
    this.createdAt = new Date(data.created_at);
    this.runningAt = data.running_at ? new Date(data.running_at) : undefined;
    this.finishedAt = data.finished_at ? new Date(data.finished_at) : undefined;
    this.lastActiveAt = new Date(data.last_active_at);
    this.exitReason = data.exit_reason;
    this.checkpoint = data.checkpoint;
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
      idleTtlSeconds: this.idleTtlSeconds,
      maxConcurrentExecs: this.maxConcurrentExecs,
      endpoints: this.endpoints?.map((endpoint) => ({ ...endpoint })),
      createdAt: this.createdAt,
      runningAt: this.runningAt,
      finishedAt: this.finishedAt,
      lastActiveAt: this.lastActiveAt,
      exitReason: this.exitReason,
      checkpoint: this.checkpoint,
    };
  }

  /** Start a process and return its handle without waiting for exit. */
  async run(
    command: string,
    options: SandboxProcessStartOptions = {},
  ): Promise<SandboxProcess> {
    const process = new SandboxProcess(
      "",
      0,
      options.onOutput,
      options.collectOutput ?? true,
      () => this._connectionUrl(),
      (request) => this._control(request),
    );
    const terminal =
      typeof options.terminal === "object"
        ? {
            cols: options.terminal.cols ?? 80,
            rows: options.terminal.rows ?? 24,
          }
        : options.terminal;
    await process._connect({
      type: "start",
      command,
      terminal,
      env: options.env ?? {},
      timeout_seconds: options.timeoutSeconds,
    });
    return process;
  }

  /** Reattach to a process, optionally resuming output from a cursor. */
  async attach(
    processId: string,
    options: SandboxProcessConnectOptions = {},
  ): Promise<SandboxProcess> {
    const offset = options.offset ?? 0;
    const process = new SandboxProcess(
      processId,
      offset,
      options.onOutput,
      options.collectOutput ?? true,
      () => this._connectionUrl(),
      (request) => this._control(request),
    );
    await process._connect({ type: "attach", process_id: processId, offset });
    return process;
  }

  private async _connectionUrl(): Promise<string> {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes/{sid}/connections", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
    return data.url;
  }

  private async _control(request: ProcessControlRequest): Promise<void> {
    const socket = await openProcessSocket(() => this._connectionUrl());
    const expected = request.type === "kill" ? "killed" : "resized";
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data as string) as
            | { type: "killed" | "resized" }
            | { type: "error"; error: string; message: string };
          if (event.type === "error") {
            reject(new Error(`${event.error}: ${event.message}`));
          } else if (event.type !== expected) {
            reject(new Error(`Expected ${expected}, received ${event.type}`));
          } else {
            resolve();
          }
        } catch (error) {
          reject(error);
        } finally {
          socket.close();
        }
      }, { once: true });
      socket.addEventListener("error", () =>
        reject(new Error(`Process ${request.type} request failed`)),
      );
      socket.addEventListener("close", () =>
        reject(
          new Error(
            `Process ${request.type} connection closed before confirmation`,
          ),
        ),
      );
      socket.send(JSON.stringify(request));
    });
  }

  /** Run a process and wait for it to exit. */
  async exec(
    command: string,
    options: SandboxProcessStartOptions = {},
  ): Promise<SandboxProcessResult> {
    const process = await this.run(command, options);
    return process.wait();
  }

  /** Re-fetch this sandbox. */
  async refresh() {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.GET("/api/sandboxes/{sid}", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
    return this._apply(data);
  }

  /** Start this sandbox. */
  async start(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes/{sid}/start", {
            params: { path: { sid: this.id }, query: { wait: options.wait ?? true } },
          }),
        "transient",
      ),
    );
    this._apply(data);
    return options.wait === false ? this : waitForSandboxStart(this);
  }

  /** Stop this sandbox. */
  async stop(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes/{sid}/stop", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
    this._apply(data);
    return options.wait === false ? this : waitWhileSandboxStatus(this, "stopping");
  }

  /** Pause this sandbox, preserving its CPU and memory state. */
  async pause(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes/{sid}/pause", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
    this._apply(data);
    return options.wait === false ? this : waitWhileSandboxStatus(this, "pausing");
  }

  /** Resume this sandbox from its preserved CPU and memory state. */
  async resume(options: SandboxWaitOptions = {}) {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes/{sid}/resume", {
            params: { path: { sid: this.id }, query: { wait: options.wait ?? true } },
          }),
        "transient",
      ),
    );
    this._apply(data);
    return options.wait === false ? this : waitForSandboxStart(this);
  }

  /**
   * Create an isolated writable branch from this sandbox's current state.
   * A running sandbox is paused for the snapshot and resumed once the fork is
   * accepted; a paused or stopped sandbox is left as it is. The fork names the
   * checkpoint the pause returned, so it does not depend on the source still
   * being paused when the request lands. Resuming the source is best effort:
   * the child is returned even if the source could not be resumed, so check
   * the source's status afterwards if that matters.
   */
  async fork(options: SandboxForkOptions = {}): Promise<Sandbox> {
    // Pause is idempotent: "pausing" means the sandbox was live and is ours to
    // resume; "paused" or "stopped" means it was already inactive.
    const paused = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes/{sid}/pause", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
    this._apply(paused);
    const resumeAfterFork = this.status === "pausing";
    const checkpoint = this.checkpoint;

    // A source we paused resumes as soon as the fork is accepted, not after the child boots.
    const wait = resumeAfterFork ? false : (options.wait ?? true);
    const body = { name: options.name, checkpoint };
    const fork = await waitWhileSandboxStatus(this, "pausing")
      .then(() =>
        unwrap(
          retryApiRequest(
            () =>
              this._client.POST("/api/sandboxes/{sid}/fork", {
                params: { path: { sid: this.id }, query: { wait } },
                body,
              }),
            "connect",
          ),
        ),
      )
      .then((data) => new Sandbox(data, this._client))
      .finally(() => (resumeAfterFork ? this.resume({ wait: false }).catch(() => undefined) : undefined));

    if (options.wait === false) return fork;
    await waitForSandboxStart(fork);
    if (resumeAfterFork) await waitForSandboxStart(this).catch(() => undefined);
    return fork;
  }

  /** Expose a TCP port publicly (1–65535), returning its hostname. */
  async exposePort(port: number): Promise<string> {
    // The endpoint is newer than the minimum @archildata/api-types version.
    const client = this._client as unknown as SandboxExtensionClient;
    const data = await unwrap(
      retryApiRequest(
        () =>
          client.PUT("/api/sandboxes/{sid}/ports/{port}", {
            params: { path: { sid: this.id, port } },
          }),
        "transient",
      ),
    );
    return data.hostname;
  }

  /** List explicitly exposed public ports. Service-published ports are in `endpoints`. */
  async listPorts(): Promise<SandboxEndpoint[]> {
    const client = this._client as unknown as SandboxExtensionClient;
    const data = await unwrap(
      retryApiRequest(
        () =>
          client.GET("/api/sandboxes/{sid}/ports", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
    return data.ports;
  }

  /** Remove explicit public exposure. A service publishing the same port remains reachable. */
  async unexposePort(port: number): Promise<void> {
    const client = this._client as unknown as SandboxExtensionClient;
    await unwrapEmpty(
      retryApiRequest(
        () =>
          client.DELETE("/api/sandboxes/{sid}/ports/{port}", {
            params: { path: { sid: this.id, port } },
          }),
        "transient",
      ),
    );
  }

  /** Authorize HTTP access to one port without making it public. */
  async createPortToken(
    port: number,
    options: CreateSandboxPortTokenOptions = {},
  ): Promise<CreatedSandboxPortToken> {
    const data = await unwrap(
      retryApiRequest(
        () => this._client.POST("/api/sandboxes/{sid}/port-tokens", {
          params: { path: { sid: this.id } },
          body: { port, ttl: options.ttl },
        }),
        "connect",
      ),
    );
    return { ...portTokenFromWire(data), hostname: data.hostname, token: data.token };
  }

  /** Get token metadata. Expired and revoked tokens return not found. */
  async getPortToken(tokenId: string): Promise<SandboxPortToken> {
    const data = await unwrap(
      retryApiRequest(
        () => this._client.GET("/api/sandboxes/{sid}/port-tokens/{token_id}", {
          params: { path: { sid: this.id, token_id: tokenId } },
        }),
        "transient",
      ),
    );
    return portTokenFromWire(data);
  }

  /** List token metadata across pages. `limit` caps the total number returned. */
  async listPortTokens(options: ListSandboxPortTokensOptions = {}): Promise<SandboxPortToken[]> {
    const tokens: SandboxPortToken[] = [];
    let cursor = options.cursor;
    for (;;) {
      const remaining = options.limit === undefined ? undefined : options.limit - tokens.length;
      if (remaining !== undefined && remaining <= 0) return tokens;
      const page = await this.listPortTokensPage({
        limit: remaining === undefined ? 100 : Math.min(remaining, 100),
        cursor,
      });
      tokens.push(...page.tokens);
      if (!page.nextCursor) return tokens;
      cursor = page.nextCursor;
    }
  }

  /** Fetch one page of token metadata; pass `nextCursor` back as `cursor`. */
  async listPortTokensPage(options: ListSandboxPortTokensOptions = {}): Promise<SandboxPortTokenPage> {
    const { data, nextCursor } = await unwrapPage(
      retryApiRequest(
        () => this._client.GET("/api/sandboxes/{sid}/port-tokens", {
          params: { path: { sid: this.id }, query: { limit: options.limit ?? 100, cursor: options.cursor } },
        }),
        "transient",
      ),
    );
    return { tokens: data.tokens.map(portTokenFromWire), nextCursor };
  }

  /** Revoke a token for new connections. Existing connections remain open. */
  async deletePortToken(token: SandboxPortToken | string): Promise<void> {
    const tokenId = typeof token === "string" ? token : token.id;
    await unwrapEmpty(
      retryApiRequest(
        () => this._client.DELETE("/api/sandboxes/{sid}/port-tokens/{token_id}", {
          params: { path: { sid: this.id, token_id: tokenId } },
        }),
        "transient",
      ),
    );
  }

  /** Get this running sandbox's effective network policy. */
  async getNetwork(): Promise<SandboxNetwork> {
    // The endpoint is newer than the minimum @archildata/api-types version.
    const client = this._client as unknown as SandboxExtensionClient;
    return unwrap(
      retryApiRequest(
        () =>
          client.GET("/api/sandboxes/{sid}/network", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
  }

  /** Replace this running sandbox's complete network policy and return the effective policy. */
  async updateNetwork(network: SandboxNetwork): Promise<SandboxNetwork> {
    // The endpoint is newer than the minimum @archildata/api-types version.
    const client = this._client as unknown as SandboxExtensionClient;
    return unwrap(
      retryApiRequest(
        () =>
          client.PUT("/api/sandboxes/{sid}/network", {
            params: { path: { sid: this.id } },
            body: network,
          }),
        "transient",
      ),
    );
  }

  /** Update either or both TTLs in seconds. Omitted settings remain unchanged. */
  async setTimeout(timeout: number | SandboxTimeoutOptions): Promise<this> {
    const options = typeof timeout === "number" ? { timeoutSeconds: timeout } : timeout;
    // The endpoint is newer than the minimum @archildata/api-types version.
    const client = this._client as unknown as SandboxExtensionClient;
    const data = await unwrap(
      retryApiRequest(
        () =>
          client.POST("/api/sandboxes/{sid}/timeout", {
            params: { path: { sid: this.id } },
            body: {
              timeout: options.timeoutSeconds,
              idle_ttl_seconds: options.idleTtlSeconds,
            },
          }),
        "transient",
      ),
    );
    return this._apply(data);
  }

  /** Delete this sandbox and its backing disk. */
  async delete(): Promise<void> {
    await unwrapEmpty(
      retryApiRequest(
        () =>
          this._client.DELETE("/api/sandboxes/{sid}", {
            params: { path: { sid: this.id } },
          }),
        "transient",
      ),
    );
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
