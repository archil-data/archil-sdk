import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import { retryApiRequest } from "./retry.js";
import type { Disk } from "./disk.js";
import type { ExecMountSpec } from "./archil.js";
import {
  Sandbox,
  type SandboxMountWire,
  type SandboxNetwork,
  type SandboxWire,
  type SandboxWaitOptions,
  waitForSandboxStart,
} from "./sandbox.js";

/**
 * One Archil disk to mount inside a sandbox. `path` is the absolute guest
 * directory; it may be omitted only for a sole mount, which then lands at
 * `/mnt/archil`. The remaining options match `ExecMountSpec`.
 */
export interface SandboxMountSpec extends ExecMountSpec {
  path?: string;
}

export interface CreateSandboxRequest {
  /** Name for the sandbox. The server generates one when omitted. */
  name?: string;
  /** Number of virtual CPUs allocated to the sandbox, from 1 to 32. Defaults to 1. */
  vcpuCount?: number;
  /** Memory allocated to the sandbox in MiB, from 256 to 65536. Defaults to 2048. */
  memSizeMiB?: number;
  /**
   * Public Linux OCI image reference for the sandbox's root filesystem.
   * Docker Hub shorthand and any public registry are accepted; the tag
   * defaults to `latest`, and mutable tags are pinned to immutable digests
   * when the sandbox is created. Defaults to `ubuntu:26.04`.
   *
   * Examples: `ubuntu`, `node:24-bookworm`, `ghcr.io/owner/app:v2`,
   * `alpine@sha256:<digest>`.
   */
  baseImage?: string;
  env?: Record<string, string>;
  maxTtlSeconds?: number;
  /** Maximum concurrently attached exec sessions. Detached processes and one-shot controls do not count. */
  maxConcurrentExecs?: number;
  /** Creation-time network policy. Egress is unrestricted when omitted. */
  network?: SandboxNetwork;
  /**
   * Disks mounted inside the guest on every boot. Fixed for the sandbox's
   * lifetime and inherited by forks.
   */
  mounts?: SandboxMountSpec[];
}

function sandboxMountWire(mount: SandboxMountSpec): SandboxMountWire {
  const entry: SandboxMountWire = {
    disk_id: typeof mount.disk === "string" ? mount.disk : mount.disk.id,
    read_only: mount.readOnly ?? false,
    conditional: mount.conditional ?? false,
  };
  if (mount.path !== undefined) entry.path = mount.path;
  if (mount.subdirectory !== undefined) entry.subdirectory = mount.subdirectory;
  if (mount.queueMs !== undefined) entry.queue_ms = mount.queueMs;
  if (mount.checkoutPaths !== undefined) entry.checkout_paths = mount.checkoutPaths;
  return entry;
}

export interface ListSandboxesOptions {
  /** Only return sandboxes that mount this disk. */
  disk?: Disk | string;
}

export class Sandboxes {
  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(client: ApiClient) {
    this._client = client;
  }

  /** List the account's sandboxes, oldest first. */
  async list(options: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const filesystem =
      typeof options.disk === "string" ? options.disk : options.disk?.id;
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.GET("/api/sandboxes", {
            params: { query: { filesystem } },
          }),
        "transient",
      ),
    );
    return ((data as { sandboxes?: SandboxWire[] } | null)?.sandboxes ?? []).map(
      (sandbox) => new Sandbox(sandbox, this._client),
    );
  }

  async get(id: string): Promise<Sandbox> {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.GET("/api/sandboxes/{sid}", {
            params: { path: { sid: id } },
          }),
        "transient",
      ),
    );
    return new Sandbox(data as SandboxWire, this._client);
  }

  async create(
    request: CreateSandboxRequest = {},
    options: SandboxWaitOptions = {},
  ): Promise<Sandbox> {
    const body = {
      name: request.name,
      vcpu_count: request.vcpuCount,
      mem_size_mib: request.memSizeMiB,
      base_image: request.baseImage,
      env: request.env,
      max_ttl_seconds: request.maxTtlSeconds,
      max_concurrent_execs: request.maxConcurrentExecs,
      network: request.network,
      ...(request.mounts && { mounts: request.mounts.map(sandboxMountWire) }),
    };
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes", {
            params: { query: { wait: options.wait ?? true } },
            body: body as components["schemas"]["CreateSandboxRequest"],
          }),
        "connect",
      ),
    );
    const sandbox = new Sandbox(data as SandboxWire, this._client);
    return options.wait === false ? sandbox : waitForSandboxStart(sandbox);
  }
}
