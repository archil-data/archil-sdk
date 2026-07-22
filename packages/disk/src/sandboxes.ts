import { type ApiClient, unwrap } from "./client.js";
import type { Disk } from "./disk.js";
import {
  Sandbox,
  toSandboxInfo,
  type SandboxPort,
  type SandboxResources,
  type SandboxWaitOptions,
} from "./sandbox.js";
import type { CreateSandboxRequest, SandboxResponse } from "./types.js";

export interface CreateSandboxOptions extends SandboxWaitOptions {
  /** Base image the sandbox boots from. Defaults to "ubuntu:26.04". */
  image?: CreateSandboxRequest["base_image"];
  kernel?: CreateSandboxRequest["kernel"];
  /** Guest ports to expose (max 4). */
  ports?: SandboxPort[];
  /** VM shape. Defaults to 1 vCPU / 2048 MiB. */
  resources?: SandboxResources;
  /** Environment variables applied to every exec. */
  env?: CreateSandboxRequest["env"];
  /**
   * The sandbox is shut down this many milliseconds after each start.
   * Defaults to 8 hours (the server-side maximum).
   */
  ttlMs?: number;
  maxConcurrentExecs?: CreateSandboxRequest["max_concurrent_execs"];
}

export interface StartSandboxOptions extends SandboxWaitOptions {
  /** Id of the sandbox to start. */
  id: string;
}

export interface ListSandboxesOptions {
  /** Only sandboxes that mount this disk. */
  disk?: Disk | string;
}

function diskId(disk: Disk | string): string {
  return typeof disk === "string" ? disk : disk.id;
}

function toCreateRequest(opts: CreateSandboxOptions): CreateSandboxRequest {
  return {
    base_image: opts.image ?? "ubuntu:26.04",
    ...(opts.resources?.vcpus !== undefined && { vcpu_count: opts.resources.vcpus }),
    ...(opts.resources?.memoryMiB !== undefined && { mem_size_mib: opts.resources.memoryMiB }),
    ...(opts.kernel !== undefined && { kernel: opts.kernel }),
    ...(opts.ports?.length && {
      port_mappings: opts.ports.map((p) => ({
        container_port: p.port,
        protocol: p.protocol ?? ("tcp" as const),
      })),
    }),
    ...(opts.env !== undefined && { env: opts.env }),
    ...(opts.ttlMs !== undefined && { max_ttl_seconds: Math.ceil(opts.ttlMs / 1000) }),
    ...(opts.maxConcurrentExecs !== undefined && {
      max_concurrent_execs: opts.maxConcurrentExecs,
    }),
  };
}

export class Sandboxes {
  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(client: ApiClient) {
    this._client = client;
  }

  /**
   * Create a sandbox. By default resolves once the sandbox is running and
   * ready for {@link Sandbox.run}; pass `wait: false` to get the pending
   * sandbox back immediately.
   */
  async create(opts: CreateSandboxOptions = {}): Promise<Sandbox> {
    const response = await unwrap<SandboxResponse>(
      this._client.POST("/api/sandboxes", {
        params: { query: { wait: opts.wait ?? true } },
        body: toCreateRequest(opts),
      }),
    );
    const sandbox = new Sandbox(this._client, toSandboxInfo(response));
    if (opts.wait ?? true) {
      await sandbox.waitUntilRunning(opts);
    }
    return sandbox;
  }

  async get(id: string): Promise<Sandbox> {
    const response = await unwrap<SandboxResponse>(
      this._client.GET("/api/sandboxes/{sid}", { params: { path: { sid: id } } }),
    );
    return new Sandbox(this._client, toSandboxInfo(response));
  }

  /** List the account's sandboxes, oldest first. */
  async list(opts: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const data = await unwrap<{ sandboxes?: SandboxResponse[] }>(
      this._client.GET("/api/sandboxes", {
        params: { query: opts.disk !== undefined ? { filesystem: diskId(opts.disk) } : {} },
      }),
    );
    return (data.sandboxes ?? []).map(
      (response) => new Sandbox(this._client, toSandboxInfo(response)),
    );
  }

  /** Start a stopped sandbox by id. See {@link Sandbox.start}. */
  async start(opts: StartSandboxOptions): Promise<Sandbox> {
    const response = await unwrap<SandboxResponse>(
      this._client.POST("/api/sandboxes/{sid}/start", {
        params: { path: { sid: opts.id }, query: { wait: opts.wait ?? true } },
      }),
    );
    const sandbox = new Sandbox(this._client, toSandboxInfo(response));
    if (opts.wait ?? true) {
      await sandbox.waitUntilRunning(opts);
    }
    return sandbox;
  }
}
