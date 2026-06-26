import { type ApiClient, createApiClient, unwrap } from "./client.js";
import { Disk } from "./disk.js";
import { Disks } from "./disks.js";
import { Tokens } from "./tokens.js";
import { Workspace } from "./workspace.js";
import { deriveS3BaseUrl, resolveBaseUrl } from "./regions.js";
import type { ExecDiskResult } from "./types.js";

export interface ArchilOptions {
  /** API key. Falls back to ARCHIL_API_KEY env var if not provided. */
  apiKey?: string;
  /** Region. Falls back to ARCHIL_REGION env var if not provided. */
  region?: string;
  /** Override the control plane base URL (useful for testing). */
  baseUrl?: string;
  /**
   * Override the S3-compatible API base URL used by Disk#getObject /
   * putObject / deleteObject. Falls back to ARCHIL_S3_BASE_URL, then to the
   * control plane URL with its `control.` hostname prefix swapped for `s3.`.
   */
  s3BaseUrl?: string;
}

/**
 * Options that apply to a single mounted disk in an exec request.
 * Use this object form when you need to pin the mount to a subdirectory
 * of the disk, mount it read-only, mount it in conditional mode, or request
 * delegation checkouts; for the default case (mount the disk's root,
 * read-write with no checkout), pass a `Disk` or disk-id string instead.
 */
export interface ExecMountSpec {
  /** Disk to mount, by `Disk` instance or raw disk id string. */
  disk: Disk | string;
  /**
   * Subdirectory of the disk to expose at the mountpoint. Must be a
   * relative path with no `.` or `..` segments. When omitted, the disk's
   * root is exposed.
   */
  subdirectory?: string;
  /**
   * When true, mount the disk read-only inside the container. Writes
   * against the mount fail with EROFS. Defaults to false.
   */
  readOnly?: boolean;
  /**
   * When true, mount the disk in conditional mode, where mutating operations
   * are sent directly to the server without a delegation checkout. This
   * enables concurrent writes from multiple clients to the same disk.
   * Defaults to false.
   */
  conditional?: boolean;
  /**
   * Milliseconds to wait in the delegation queue for each requested checkout.
   * If set without `checkoutPaths`, the exposed mount root is acquired during
   * mount setup. Cannot be combined with `readOnly: true`.
   */
  queueMs?: number;
  /**
   * Paths relative to this disk's exposed mount root to check out before the
   * command starts. May be set without `queueMs`; those checkouts try
   * immediately without waiting in the delegation queue. Cannot be combined
   * with `readOnly: true`.
   */
  checkoutPaths?: string[];
}

/**
 * One disk to mount in an exec request. Either a `Disk`/disk-id string
 * (mounts the disk's root, read-write) or an `ExecMountSpec` object that
 * additionally selects a subdirectory of the disk and/or marks the mount as
 * read-only, conditional, or requests delegation checkouts. Used
 * by Archil#exec, where the map key is the relative path under /mnt/archil at
 * which to mount the disk.
 */
export type ExecMount = Disk | string | ExecMountSpec;

export interface ExecOptions {
  /**
   * Disks to mount, keyed by the relative path under `/mnt/archil` at which
   * to mount each one. At least one entry is required. Paths must be
   * non-empty, non-absolute, and contain no `.` or `..` segments.
   */
  disks: Record<string, ExecMount>;
  /** Shell command to run inside the container. */
  command: string;
}

/**
 * Read an environment variable in a way that is safe in browsers, where the
 * `process` global does not exist. Returns undefined when there is no process
 * environment, so the SDK can be bundled and run client-side as long as
 * credentials are passed explicitly to `new Archil({ ... })`.
 */
function envVar(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

function isExecMountSpec(m: ExecMount): m is ExecMountSpec {
  return typeof m === "object" && m !== null && "disk" in m;
}

function diskIdFromMount(m: Disk | string): string {
  return typeof m === "string" ? m : m.id;
}

export class Archil {
  readonly disks: Disks;
  readonly tokens: Tokens;
  /** @internal */
  private readonly _client: ApiClient;

  constructor(opts: ArchilOptions = {}) {
    const apiKey = opts.apiKey ?? envVar("ARCHIL_API_KEY");
    const region = opts.region ?? envVar("ARCHIL_REGION");

    if (!apiKey) {
      throw new Error("Missing API key: pass apiKey in options or set ARCHIL_API_KEY environment variable");
    }
    if (!region) {
      throw new Error("Missing region: pass region in options or set ARCHIL_REGION environment variable");
    }

    // Resolve the control-plane URL the same way the client does (explicit
    // override, else region lookup) so the S3 endpoint can be derived from it
    // even on the common region-based path.
    const controlBaseUrl = opts.baseUrl ?? resolveBaseUrl(region);

    const client = createApiClient({
      apiKey,
      region,
      baseUrl: controlBaseUrl,
    });

    // Derive the S3 endpoint from the control plane URL when not given
    // explicitly (swap the leading `control.` hostname segment for `s3.`).
    const s3BaseUrl =
      opts.s3BaseUrl ?? envVar("ARCHIL_S3_BASE_URL") ?? deriveS3BaseUrl(controlBaseUrl);

    this._client = client;
    this.disks = new Disks(client, region, s3BaseUrl);
    this.tokens = new Tokens(client);
  }

  /**
   * Run a command in a container with multiple disks mounted simultaneously,
   * each at its own relative path under `/mnt/archil`. Blocks until the
   * command completes and returns its stdout, stderr, exit code, and timing.
   */
  async exec(opts: ExecOptions): Promise<ExecDiskResult> {
    type ExecDiskWire = {
      disk: string;
      subdirectory?: string;
      readOnly: boolean;
      conditional: boolean;
      queueMs?: number;
      checkoutPaths?: string[];
    };
    const disks: Record<string, string | ExecDiskWire> = {};
    for (const [relPath, mount] of Object.entries(opts.disks)) {
      if (isExecMountSpec(mount)) {
        const entry: ExecDiskWire = {
          disk: diskIdFromMount(mount.disk),
          readOnly: mount.readOnly ?? false,
          conditional: mount.conditional ?? false,
        };
        if (mount.subdirectory !== undefined) entry.subdirectory = mount.subdirectory;
        if (mount.queueMs !== undefined) {
          entry.queueMs = mount.queueMs;
        }
        if (mount.checkoutPaths !== undefined) {
          entry.checkoutPaths = mount.checkoutPaths;
        }
        disks[relPath] = entry;
      } else {
        disks[relPath] = diskIdFromMount(mount);
      }
    }
    return unwrap<ExecDiskResult>(
      this._client.POST("/api/exec", {
        body: { disks, command: opts.command },
      }),
    );
  }

  /**
   * Build an agent filesystem toolset spanning several disks at once. `mounts`
   * maps a relative path to a disk (or `ExecMountSpec`), exactly like
   * {@link exec}; each disk appears under `/mnt/archil/<path>`. Hand the result
   * to a framework adapter (`agentTools(workspace)`) to get tools that route
   * file operations by path and fan `grep`/`list_files` out across the disks.
   */
  workspace(mounts: Record<string, ExecMount>): Workspace {
    return new Workspace(this, mounts);
  }
}
