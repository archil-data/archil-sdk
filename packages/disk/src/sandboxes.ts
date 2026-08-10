import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import type { Disk } from "./disk.js";
import {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  Sandbox,
  type SandboxWire,
  type SandboxWaitOptions,
  validateTimeoutMs,
  waitForSandboxStart,
} from "./sandbox.js";

export interface CreateSandboxRequest {
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
  maxConcurrentExecs?: number;
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
      this._client.GET("/api/sandboxes", {
        params: { query: { filesystem } },
      }),
    );
    return ((data as { sandboxes?: SandboxWire[] } | null)?.sandboxes ?? []).map(
      (sandbox) => new Sandbox(sandbox, this._client),
    );
  }

  async get(id: string): Promise<Sandbox> {
    const data = await unwrap(
      this._client.GET("/api/sandboxes/{sid}", {
        params: { path: { sid: id } },
      }),
    );
    return new Sandbox(data as SandboxWire, this._client);
  }

  async create(
    request: CreateSandboxRequest = {},
    options: SandboxWaitOptions = {},
  ): Promise<Sandbox> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
    validateTimeoutMs(timeoutMs);
    const deadline = Date.now() + timeoutMs;

    const body = {
      vcpu_count: request.vcpuCount,
      mem_size_mib: request.memSizeMiB,
      base_image: request.baseImage,
      env: request.env,
      max_ttl_seconds: request.maxTtlSeconds,
      max_concurrent_execs: request.maxConcurrentExecs,
    };
    const data = await unwrap(
      this._client.POST("/api/sandboxes", {
        params: { query: { wait: false } },
        body: body as components["schemas"]["CreateSandboxRequest"],
      }),
    );
    const sandbox = new Sandbox(data as SandboxWire, this._client);
    return waitForSandboxStart(sandbox, deadline, timeoutMs);
  }
}
