import { unwrap } from "./client.js";
import type { Disk } from "./disk.js";
import type { CreateSandboxWire, SandboxWire } from "./sandbox-api.js";
import {
  Sandbox,
  toSandboxInfo,
  type SandboxApiClient,
  type SandboxPort,
  type SandboxResources,
  type SandboxWaitOptions,
} from "./sandbox.js";

/** One Archil disk to mount in a sandbox. */
export interface SandboxMount {
  /** Disk to mount, by `Disk` instance or raw disk id string. */
  disk: Disk | string;
  /**
   * Mount point relative to the archil root inside the sandbox. May be
   * omitted when the sandbox mounts a single disk.
   */
  path?: string;
  /** Expose a subdirectory of the disk instead of its root. */
  subdirectory?: string;
  /** Mount read-only; writes inside the sandbox fail with EROFS. */
  readOnly?: boolean;
  /**
   * Mount in shared mode, allowing concurrent writers on other clients.
   * Defaults to true.
   */
  shared?: boolean;
  region?: string;
}

export interface CreateSandboxOptions extends SandboxWaitOptions {
  /** Base image the sandbox boots from. Defaults to "ubuntu-22.04". */
  image?: string;
  kernel?: string;
  /** Archil disks to mount inside the sandbox. */
  disks?: SandboxMount[];
  /** Guest ports to expose (max 4). */
  ports?: SandboxPort[];
  /** VM shape. Defaults to 1 vCPU / 2048 MiB. */
  resources?: SandboxResources;
  /** Environment variables applied to every exec. */
  env?: Record<string, string>;
  /**
   * The sandbox is shut down this many milliseconds after each start.
   * Defaults to 8 hours (the server-side maximum).
   */
  ttlMs?: number;
  maxConcurrentExecs?: number;
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

function toCreateWire(opts: CreateSandboxOptions): CreateSandboxWire {
  return {
    ...(opts.resources?.vcpus !== undefined && { vcpu_count: opts.resources.vcpus }),
    ...(opts.resources?.memoryMiB !== undefined && { mem_size_mib: opts.resources.memoryMiB }),
    ...(opts.kernel !== undefined && { kernel: opts.kernel }),
    ...(opts.image !== undefined && { base_image: opts.image }),
    ...(opts.disks?.length && {
      archil_mounts: opts.disks.map((m) => ({
        disk_id: diskId(m.disk),
        ...(m.path !== undefined && { relative_path: m.path }),
        ...(m.subdirectory !== undefined && { subdirectory: m.subdirectory }),
        ...(m.readOnly !== undefined && { read_only: m.readOnly }),
        ...(m.shared !== undefined && { shared: m.shared }),
        ...(m.region !== undefined && { region: m.region }),
      })),
    }),
    ...(opts.ports?.length && {
      port_mappings: opts.ports.map((p) => ({
        container_port: p.port,
        protocol: p.protocol ?? ("tcp" as const),
      })),
    }),
    ...(opts.env !== undefined && { env: opts.env }),
    ...(opts.ttlMs !== undefined && { max_ttl_seconds: Math.round(opts.ttlMs / 1000) }),
    ...(opts.maxConcurrentExecs !== undefined && {
      max_concurrent_execs: opts.maxConcurrentExecs,
    }),
  };
}

export class Sandboxes {
  /** @internal */
  private readonly _client: SandboxApiClient;

  /** @internal */
  constructor(client: SandboxApiClient) {
    this._client = client;
  }

  /**
   * Create a sandbox. By default resolves once the sandbox is running and
   * ready for {@link Sandbox.run}; pass `wait: false` to get the pending
   * sandbox back immediately.
   */
  async create(opts: CreateSandboxOptions = {}): Promise<Sandbox> {
    const wire = await unwrap<SandboxWire>(
      this._client.POST("/api/sandboxes", { body: toCreateWire(opts) }),
    );
    const sandbox = new Sandbox(this._client, toSandboxInfo(wire));
    if (opts.wait ?? true) {
      await sandbox.waitUntilRunning(opts);
    }
    return sandbox;
  }

  async get(id: string): Promise<Sandbox> {
    const wire = await unwrap<SandboxWire>(
      this._client.GET("/api/sandboxes/{sid}", { params: { path: { sid: id } } }),
    );
    return new Sandbox(this._client, toSandboxInfo(wire));
  }

  /** List the account's sandboxes, oldest first. */
  async list(opts: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const data = await unwrap<{ sandboxes?: SandboxWire[] }>(
      this._client.GET("/api/sandboxes", {
        params: { query: opts.disk !== undefined ? { filesystem: diskId(opts.disk) } : {} },
      }),
    );
    return (data.sandboxes ?? []).map((w) => new Sandbox(this._client, toSandboxInfo(w)));
  }

  /** Start (or resume) a stopped sandbox by id. See {@link Sandbox.start}. */
  async start(opts: StartSandboxOptions): Promise<Sandbox> {
    const wire = await unwrap<SandboxWire>(
      this._client.POST("/api/sandboxes/{sid}/start", { params: { path: { sid: opts.id } } }),
    );
    const sandbox = new Sandbox(this._client, toSandboxInfo(wire));
    if (opts.wait ?? true) {
      await sandbox.waitUntilRunning(opts);
    }
    return sandbox;
  }
}
