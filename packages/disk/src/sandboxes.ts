import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import type { Disk } from "./disk.js";
import {
  DEFAULT_SANDBOX_WAIT_UP_TO_MS,
  Sandbox,
  type SandboxWire,
  type WaitForStartOptions,
  validateWaitUpToMs,
  waitForSandboxStart,
} from "./sandbox.js";

export interface CreateSandboxRequest {
  vcpuCount?: number;
  memSizeMiB?: number;
  kernel?: string;
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
    options: WaitForStartOptions = {},
  ): Promise<Sandbox> {
    const waitForStart = options.waitForStart ?? true;
    const waitUpToMs = options.waitUpToMs ?? DEFAULT_SANDBOX_WAIT_UP_TO_MS;
    if (waitForStart) validateWaitUpToMs(waitUpToMs);
    const deadline = Date.now() + waitUpToMs;

    const body = {
      vcpu_count: request.vcpuCount,
      mem_size_mib: request.memSizeMiB,
      kernel: request.kernel,
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
    return waitForStart
      ? waitForSandboxStart(sandbox, deadline, waitUpToMs)
      : sandbox;
  }
}
