import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap, unwrapPage } from "./client.js";
import { retryApiRequest } from "./retry.js";
import type { Disk } from "./disk.js";
import {
  Sandbox,
  type SandboxMountSpec,
  type SandboxNetwork,
  type SandboxWire,
  type SandboxWaitOptions,
  sandboxMountWire,
  waitForSandboxStart,
} from "./sandbox.js";

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
  /** Ready image from `images.build()`. Cannot be combined with `baseImage`. */
  imageId?: string;
  env?: Record<string, string>;
  maxTtlSeconds?: number;
  /** Seconds without a direct process connection before pausing. Omitted or zero disables idle expiry. */
  idleTtlSeconds?: number;
  /** Maximum concurrently attached exec sessions. Detached processes and one-shot controls do not count. */
  maxConcurrentExecs?: number;
  /** Creation-time network policy. Egress is unrestricted when omitted. */
  network?: SandboxNetwork;
  /** TCP ports to expose publicly, from 1 to 65535. */
  ports?: number[];
  /**
   * Disks mounted inside the guest for the first session; `sandbox.start()`
   * can replace them later. A sandbox with mounts must be stopped before it
   * is forked.
   */
  mounts?: SandboxMountSpec[];
  /**
   * Key-value labels for finding the sandbox later with `list({ labels })`.
   * Forks keep them. Up to 32; keys are 1-63 letters, digits, or `. _ / : -`,
   * and values at most 256 bytes.
   */
  labels?: Record<string, string>;
}

export interface ListSandboxesOptions {
  /** Only return sandboxes that mount this disk. */
  disk?: Disk | string;
  /** Only return sandboxes carrying every one of these labels. */
  labels?: Record<string, string>;
  /** Only return the sandbox with this name. */
  name?: string;
  /** Only return sandboxes whose name starts with this. */
  namePrefix?: string;
}

/** `labels` is newer than the minimum @archildata/api-types version. */
type CreateSandboxWire = components["schemas"]["CreateSandboxRequest"] & {
  labels?: Record<string, string>;
};

/** Server-side maximum page size for `GET /api/sandboxes`. */
const SANDBOX_PAGE_LIMIT = 100;

/** The list filters and paging are newer than the minimum @archildata/api-types version. */
type SandboxListClient = {
  GET(
    path: "/api/sandboxes",
    options: {
      params: {
        query: {
          filesystem?: string;
          label?: string[];
          name?: string;
          name_prefix?: string;
          limit: number;
          cursor?: string;
        };
      };
    },
  ): Promise<{
    data?: {
      success: boolean;
      data?: { sandboxes?: SandboxWire[] } | null;
      nextCursor?: string;
      error?: string;
    };
    error?: unknown;
    response: Response;
  }>;
};

function matchesListFilters(sandbox: SandboxWire, options: ListSandboxesOptions): boolean {
  return (
    Object.entries(options.labels ?? {}).every(([key, value]) => sandbox.labels?.[key] === value) &&
    (options.name === undefined || sandbox.name === options.name) &&
    sandbox.name.startsWith(options.namePrefix ?? "")
  );
}

export class Sandboxes {
  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(client: ApiClient) {
    this._client = client;
  }

  /**
   * List the account's sandboxes, oldest first, keeping those that match every
   * filter given. Follows the server's pages until none remain.
   */
  async list(options: ListSandboxesOptions = {}): Promise<Sandbox[]> {
    const filesystem =
      typeof options.disk === "string" ? options.disk : options.disk?.id;
    const labels = Object.entries(options.labels ?? {}).map(([key, value]) => `${key}=${value}`);
    const client = this._client as unknown as SandboxListClient;
    const sandboxes: Sandbox[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { data, nextCursor } = await unwrapPage(
        retryApiRequest(
          () =>
            client.GET("/api/sandboxes", {
              params: {
                query: {
                  filesystem,
                  label: labels.length > 0 ? labels : undefined,
                  name: options.name,
                  name_prefix: options.namePrefix,
                  limit: SANDBOX_PAGE_LIMIT,
                  cursor,
                },
              },
            }),
          "transient",
        ),
      );
      for (const sandbox of data?.sandboxes ?? []) {
        // A control plane that predates these filters ignores them.
        if (matchesListFilters(sandbox, options)) sandboxes.push(new Sandbox(sandbox, this._client));
      }
      if (!nextCursor || nextCursor === cursor) return sandboxes;
      cursor = nextCursor;
    }
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
      image_id: request.imageId,
      env: request.env,
      max_ttl_seconds: request.maxTtlSeconds,
      idle_ttl_seconds: request.idleTtlSeconds,
      max_concurrent_execs: request.maxConcurrentExecs,
      network: request.network,
      ports: request.ports,
      ...(request.mounts !== undefined && { mounts: request.mounts.map(sandboxMountWire) }),
      labels: request.labels,
    } satisfies Partial<CreateSandboxWire>;
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/sandboxes", {
            params: { query: { wait: options.wait ?? true } },
            // Generated types require defaulted fields; omission lets the server choose them.
            body: body as CreateSandboxWire,
          }),
        "connect",
      ),
    );
    const sandbox = new Sandbox(data as SandboxWire, this._client);
    return options.wait === false ? sandbox : waitForSandboxStart(sandbox);
  }
}
