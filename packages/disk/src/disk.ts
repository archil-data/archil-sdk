import type { ApiClient } from "./client.js";
import { unwrap, unwrapEmpty } from "./client.js";
import { ArchilS3Error, parseS3Error } from "./errors.js";
import { parseXml } from "./s3xml.js";
import type { FileSystem } from "./filesystem.js";
import type {
  DiskResponse,
  DiskUser,
  AuthorizedUser,
  MountResponse,
  DiskMetrics,
  ConnectedClient,
  DiskStatus,
  ExecDiskResult,
  ExecTiming as ExecTimingSchema,
  GrepDiskResult,
  GrepMatch,
  GrepStoppedReason,
} from "./types.js";

export interface MountOptions {
  authToken?: string;
  logLevel?: string;
  serverAddress?: string;
  insecure?: boolean;
}

export type ExecTiming = ExecTimingSchema;
export type ExecResult = ExecDiskResult;

export type GrepResult = GrepDiskResult;
export type { GrepMatch, GrepStoppedReason };

export interface GrepOptions {
  /**
   * Directory on the disk to search, relative to the disk root. An empty
   * string or "/" means the disk root.
   */
  directory: string;
  /** Extended regular expression (passed to `grep -E`). */
  pattern: string;
  /** Walk subdirectories breadth-first. Defaults to false. */
  recursive?: boolean;
  /** Wall-clock deadline for the entire request. Defaults to 30s. */
  maxDurationSeconds?: number;
  /**
   * Maximum number of parallel grep workers. Higher values finish larger
   * datasets within the deadline but consume more runtime capacity. The
   * controlplane clamps this to the fleet's currently-available capacity.
   * Defaults to 50.
   */
  concurrency?: number;
  /**
   * Stop scanning once the aggregator has this many matches. Returned
   * matches are a sample of whichever workers reported first, not the
   * lexicographically first N. Defaults to 1000.
   */
  maxResults?: number;
}

export interface ShareUrlOptions {
  /**
   * Lifetime of the URL in seconds — any positive integer, up to 604800
   * (7 days). Defaults to 86400 (24 hours).
   */
  expiresIn?: number;
}

export interface ShareUrlResult {
  /** Public, signed, time-limited URL that downloads the file. */
  url: string;
  /** Lifetime of the URL in seconds. */
  expiresIn: number;
}

export interface ListObjectsOptions {
  /**
   * List the entire subtree under the prefix. When false (the default), only
   * the immediate level is returned — direct objects in `objects` and
   * subdirectory prefixes in `commonPrefixes`, like listing a single directory.
   * When true, every key under the prefix is returned flat (and
   * `commonPrefixes` is empty).
   */
  recursive?: boolean;
  /**
   * Return only the first page instead of auto-paginating. By default
   * listObjects follows continuation tokens until the listing is exhausted and
   * returns every matching key. With `singlePage: true` it makes one request
   * and the result carries `isTruncated` / `nextContinuationToken` so you can
   * page manually (pass the token back via `continuationToken`).
   */
  singlePage?: boolean;
  /**
   * Stop after this many objects total (only meaningful when auto-paginating).
   * The result's `isTruncated` is true if the cap cut the listing short.
   */
  limit?: number;
  /** Start listing from this continuation token (from a prior `nextContinuationToken`). */
  continuationToken?: string;
  /** Return keys lexicographically after this one. */
  startAfter?: string;
}

export interface S3Object {
  /** Object key (path on the disk). */
  key: string;
  /** Size in bytes. */
  size: number;
  /** Entity tag (quoted MD5 for single-part objects). */
  etag?: string;
  /** Last-modified time, if reported by the server. */
  lastModified?: Date;
}

export interface PutObjectResult {
  /** Entity tag the server assigned (quoted, per S3 — e.g. `"\"abc123\""`). */
  etag?: string;
}

export interface ObjectMetadata {
  /** Size in bytes. */
  size: number;
  /** Entity tag (quoted MD5 for single-part objects). */
  etag?: string;
  /** MIME type the object was stored with, if any. */
  contentType?: string;
  /** Last-modified time, if reported by the server. */
  lastModified?: Date;
}

export interface ListObjectsResult {
  /** Objects in this page. */
  objects: S3Object[];
  /** Directory-like prefixes rolled up by `delimiter` (empty if no delimiter). */
  commonPrefixes: string[];
  /** True if more keys exist beyond this page. */
  isTruncated: boolean;
  /** Token to pass as `continuationToken` to fetch the next page. */
  nextContinuationToken?: string;
  /** Number of keys returned in this page. */
  keyCount: number;
  /** The prefix the listing was filtered by, echoed back by the server. */
  prefix?: string;
}

/** A part to list in {@link Disk.completeMultipartUpload}. */
export interface UploadPart {
  /** 1-based part number (1..=10000), strictly increasing across the list. */
  partNumber: number;
  /** Entity tag returned by {@link Disk.uploadPart} for this part. */
  etag: string;
}

/** Handle to an in-progress multipart upload, returned by {@link Disk.createMultipartUpload}. */
export interface MultipartUpload {
  /** Server-assigned upload id; pass to uploadPart/complete/abort/listParts. */
  uploadId: string;
  /** The object key this upload targets. */
  key: string;
  /** The bucket (disk id) the upload lives in. */
  bucket: string;
}

/** The assembled object, returned by {@link Disk.completeMultipartUpload}. */
export interface CompletedMultipartUpload {
  /** Multipart entity tag — S3's `md5(concat(partMd5s))-N` form. */
  etag?: string;
  /** Resource path of the completed object. */
  location?: string;
  /** The bucket (disk id). */
  bucket?: string;
  /** The object key. */
  key?: string;
}

/** One part in a {@link Disk.listParts} listing. */
export interface PartInfo {
  /** 1-based part number. */
  partNumber: number;
  /** Entity tag the server assigned to this part. */
  etag?: string;
  /** Size in bytes. */
  size: number;
  /** Time the part was uploaded, if reported. */
  lastModified?: Date;
}

export interface ListPartsOptions {
  /** Cap parts returned in one page (server clamps to 1000). */
  maxParts?: number;
  /** Return parts after this part number (for pagination). */
  partNumberMarker?: number;
}

export interface PartListing {
  /** The bucket (disk id), echoed by the server. */
  bucket?: string;
  /** The object key, echoed by the server. */
  key?: string;
  /** The upload id, echoed by the server. */
  uploadId?: string;
  /** Parts in this page, ascending by part number. */
  parts: PartInfo[];
  /** True if more parts exist beyond this page. */
  isTruncated: boolean;
  /** The part-number marker this page started after. */
  partNumberMarker: number;
  /** Pass back as `partNumberMarker` to fetch the next page. */
  nextPartNumberMarker?: number;
  /** Max parts the server was asked to return. */
  maxParts: number;
}

/** One in-progress upload in a {@link Disk.listMultipartUploads} listing. */
export interface MultipartUploadSummary {
  /** The object key the upload targets. */
  key: string;
  /** The upload id. */
  uploadId: string;
  /** When the upload was initiated, if reported. */
  initiated?: Date;
}

export interface ListMultipartUploadsOptions {
  /** Only list uploads whose key begins with this prefix. */
  prefix?: string;
  /** Roll keys up to this delimiter into `commonPrefixes` (S3 supports "/"). */
  delimiter?: string;
  /** Resume listing keys after this one (with `uploadIdMarker`). */
  keyMarker?: string;
  /** Resume listing uploads after this upload id (requires `keyMarker`). */
  uploadIdMarker?: string;
  /** Cap uploads returned in one page (server clamps to 1000). */
  maxUploads?: number;
}

export interface MultipartUploadListing {
  /** The bucket (disk id), echoed by the server. */
  bucket?: string;
  /** In-progress uploads in this page. */
  uploads: MultipartUploadSummary[];
  /** Key prefixes rolled up by `delimiter` (empty if no delimiter). */
  commonPrefixes: string[];
  /** True if more uploads exist beyond this page. */
  isTruncated: boolean;
  /** The key marker this page started after, echoed back. */
  keyMarker?: string;
  /** The upload-id marker this page started after, echoed back. */
  uploadIdMarker?: string;
  /** Pass back as `keyMarker` (with `nextUploadIdMarker`) for the next page. */
  nextKeyMarker?: string;
  /** Pass back as `uploadIdMarker` (with `nextKeyMarker`) for the next page. */
  nextUploadIdMarker?: string;
  /** The prefix the listing was filtered by, echoed back. */
  prefix?: string;
  /** The delimiter used, echoed back. */
  delimiter?: string;
  /** Max uploads the server was asked to return. */
  maxUploads?: number;
}

export interface DeleteObjectsOptions {
  /**
   * Quiet mode: the server omits the per-key success list and returns only
   * failures, so the result's `deleted` array is empty. Cuts response size on
   * large batches. Defaults to false.
   */
  quiet?: boolean;
}

/** A single per-key failure within a {@link Disk.deleteObjects} batch. */
export interface DeleteObjectsError {
  /** The key that failed to delete. */
  key: string;
  /** S3 error code (e.g. "AccessDenied", "OperationAborted"), if provided. */
  code?: string;
  /** Human-readable failure detail, if provided. */
  message?: string;
}

export interface DeleteObjectsResult {
  /** Keys the server confirmed deleted (empty in quiet mode). */
  deleted: string[];
  /** Per-key failures; empty when every key was deleted. */
  errors: DeleteObjectsError[];
}

export interface PutObjectOptions {
  /** MIME type to store the object with. Default "application/octet-stream". */
  contentType?: string;
  /**
   * Bodies larger than this take the multipart path; bodies at or below it take
   * a single PutObject. Defaults to `partSize` (16 MiB), so by default the
   * switch happens at the part size. Set it lower (e.g. 5 MiB) to start using
   * multipart sooner, or to `Infinity` to force a single PutObject.
   */
  multipartThreshold?: number;
  /**
   * Bytes per part on the multipart path. Clamped to a minimum of 5 MiB (the S3
   * floor for every part but the last). Default 16 MiB.
   */
  partSize?: number;
  /** Max parts uploaded in parallel on the multipart path. Default 4. */
  concurrency?: number;
}

/**
 * The S3 transport function {@link DiskMultipart} uses, supplied by the owning
 * {@link Disk} so the namespace shares the disk's credential and endpoint.
 * @internal
 */
type S3RequestFn = (
  method: "GET" | "PUT" | "DELETE" | "HEAD" | "POST",
  key: string,
  opts?: {
    body?: string | Uint8Array | ArrayBuffer;
    contentType?: string;
    query?: Record<string, string | number>;
    retry?: boolean;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; headers: Headers; body: Uint8Array }>;

export class Disk implements FileSystem {
  readonly id: string;
  readonly name: string;
  readonly organization: string;
  readonly status: DiskStatus;
  readonly provider: string;
  readonly region: string;
  readonly createdAt: string;
  readonly fsHandlerStatus?: string;
  readonly lastAccessed?: string;
  readonly dataSize?: number;
  readonly monthlyUsage?: string;
  readonly mounts?: MountResponse[];
  readonly metrics?: DiskMetrics;
  readonly connectedClients?: ConnectedClient[];
  readonly authorizedUsers?: AuthorizedUser[];
  readonly allowedIps?: string[];

  /** @internal */
  private readonly _client: ApiClient;
  /** @internal */
  private readonly _archilRegion: string;
  /** Base URL for the S3-compatible API (port 9000 ingress). Empty if unset. */
  private readonly _s3BaseUrl: string;
  /** Lazily-constructed multipart namespace (see {@link multipart}). @internal */
  private _multipart?: DiskMultipart;

  /** @internal */
  constructor(data: DiskResponse, client: ApiClient, archilRegion: string, s3BaseUrl?: string) {
    this.id = data.id;
    this.name = data.name;
    this.organization = data.organization;
    this.status = data.status;
    this.provider = data.provider;
    this.region = data.region;
    this.createdAt = data.createdAt;
    this.fsHandlerStatus = data.fsHandlerStatus;
    this.lastAccessed = data.lastAccessed;
    this.dataSize = data.dataSize;
    this.monthlyUsage = data.monthlyUsage;
    this.mounts = data.mounts;
    this.metrics = data.metrics;
    this.connectedClients = data.connectedClients;
    this.authorizedUsers = data.authorizedUsers;
    this.allowedIps = data.allowedIps;
    this._client = client;
    this._archilRegion = archilRegion;
    this._s3BaseUrl = s3BaseUrl ?? "";
  }

  toJSON(): DiskResponse {
    return {
      id: this.id,
      name: this.name,
      organization: this.organization,
      status: this.status,
      provider: this.provider,
      region: this.region,
      createdAt: this.createdAt,
      fsHandlerStatus: this.fsHandlerStatus,
      lastAccessed: this.lastAccessed,
      dataSize: this.dataSize,
      monthlyUsage: this.monthlyUsage,
      mounts: this.mounts,
      metrics: this.metrics,
      connectedClients: this.connectedClients,
      authorizedUsers: this.authorizedUsers,
      allowedIps: this.allowedIps,
    } as DiskResponse;
  }

  async addUser(user: DiskUser): Promise<AuthorizedUser> {
    return unwrap(
      this._client.POST("/api/disks/{id}/users", {
        params: { path: { id: this.id } },
        body: user,
      }),
    );
  }

  async removeUser(userType: "token" | "awssts", identifier: string): Promise<void> {
    await unwrapEmpty(
      this._client.DELETE("/api/disks/{id}/users/{userType}", {
        params: {
          path: { id: this.id, userType },
          query: { identifier },
        },
      }),
    );
  }

  async createToken(nickname: string): Promise<AuthorizedUser & { token: string; identifier: string }> {
    const user = (await unwrap(
      this._client.POST("/api/disks/{id}/users", {
        params: { path: { id: this.id } },
        body: { type: "token", nickname },
      }),
    )) as AuthorizedUser;
    if (!user.token || !user.identifier) {
      throw new Error("Server did not return a generated token");
    }
    return user as AuthorizedUser & { token: string; identifier: string };
  }

  async removeTokenUser(identifier: string): Promise<void> {
    await this.removeUser("token", identifier);
  }

  async getAllowedIPs(): Promise<string[]> {
    const data = await unwrap(
      this._client.GET("/api/disks/{id}/allowed-ips", {
        params: { path: { id: this.id } },
      }),
    );
    return (data as { allowedIps: string[] }).allowedIps;
  }

  async setAllowedIPs(allowedIps: string[]): Promise<string[]> {
    const data = await unwrap(
      this._client.PUT("/api/disks/{id}/allowed-ips", {
        params: { path: { id: this.id } },
        body: { allowedIps },
      }),
    );
    return (data as { allowedIps: string[] }).allowedIps;
  }

  async addAllowedIP(ip: string): Promise<string[]> {
    const current = await this.getAllowedIPs();
    if (current.includes(ip)) return current;
    return this.setAllowedIPs([...current, ip]);
  }

  async removeAllowedIP(ip: string): Promise<string[]> {
    const current = await this.getAllowedIPs();
    return this.setAllowedIPs(current.filter(i => i !== ip));
  }

  async delete(): Promise<void> {
    await unwrapEmpty(
      this._client.DELETE("/api/disks/{id}", {
        params: { path: { id: this.id } },
      }),
    );
  }

  /**
   * Execute a command in a container with this disk mounted.
   * Blocks until the command completes and returns stdout, stderr, and exit code.
   */
  async exec(command: string): Promise<ExecResult> {
    return unwrap<ExecResult>(
      this._client.POST("/api/disks/{id}/exec", {
        params: { path: { id: this.id } },
        body: { command },
      }),
    );
  }

  /**
   * Constant-time parallel grep across files on this disk. Listing and
   * matching are fanned out across ephemeral exec containers; the request
   * finishes within the supplied time budget regardless of dataset size.
   *
   * The returned `stoppedReason` says whether the search ran to completion
   * or short-circuited on `maxResults` / `maxDurationSeconds`. When
   * stopping early, the matches returned are a sample (whichever workers
   * reported first), not the lexicographically first N.
   */
  async grep(opts: GrepOptions): Promise<GrepResult> {
    return unwrap<GrepResult>(
      this._client.POST("/api/disks/{id}/grep", {
        params: { path: { id: this.id } },
        body: {
          directory: opts.directory,
          pattern: opts.pattern,
          recursive: opts.recursive ?? false,
          maxDurationSeconds: opts.maxDurationSeconds ?? 30,
          concurrency: opts.concurrency ?? 50,
          maxResults: opts.maxResults ?? 1000,
        },
      }),
    );
  }

  /**
   * Create a signed, time-limited URL that lets anyone download a single file
   * from this disk without authentication. The returned URL embeds a
   * cryptographically signed token carrying the disk, the file's key, and an
   * expiry — share it directly; no API key is needed to redeem it.
   *
   * @param key   Path to the file on the disk (e.g. "reports/2026-01/data.pdf").
   * @param opts  `expiresIn` sets the URL lifetime in seconds (any positive
   *              integer, max 604800 = 7 days). Defaults to 24h.
   */
  async share(key: string, opts: ShareUrlOptions = {}): Promise<ShareUrlResult> {
    // The key and expiry go in the JSON body, so no path/query encoding is
    // needed for keys containing "/" or other reserved characters. The share
    // route isn't part of the typed control-plane API, so the call is untyped
    // (the response is still validated and unwrapped below).
    const body: { key: string; expiresIn?: number } = { key };
    if (opts.expiresIn !== undefined) body.expiresIn = opts.expiresIn;

    const call = this._client.POST as unknown as (
      url: string,
      init: Record<string, unknown>,
    ) => Promise<{
      data?: { success: boolean; data?: ShareUrlResult; error?: string };
      error?: unknown;
      response: Response;
    }>;

    return unwrap<ShareUrlResult>(call(`/api/disks/${this.id}/share`, { body }));
  }

  /**
   * Read an object from the disk via the S3-compatible GetObject API and return
   * its full contents as bytes. Throws `ArchilS3Error` if the object does not
   * exist (status 404, code "NoSuchKey") or the request is rejected; use
   * `headObject`/`objectExists` to check existence without throwing.
   *
   * @param key  Path on the disk (e.g. "reports/2026-01/data.json")
   */
  async getObject(key: string): Promise<Uint8Array> {
    const resp = await this._s3Request("GET", key);
    if (!resp.ok) {
      throw parseS3Error("GetObject", resp.status, resp.statusText, decodeText(resp.body));
    }
    return resp.body;
  }

  /**
   * Fetch an object's metadata (size, etag, content type, last-modified) without
   * downloading its contents, via the S3-compatible HeadObject API. Returns
   * `null` if the object does not exist.
   *
   * @param key  Path on the disk (e.g. "reports/2026-01/data.json")
   */
  async headObject(key: string): Promise<ObjectMetadata | null> {
    const resp = await this._s3Request("HEAD", key);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw parseS3Error("HeadObject", resp.status, resp.statusText, decodeText(resp.body));
    }
    const lastModified = resp.headers.get("last-modified");
    return {
      size: Number(resp.headers.get("content-length") ?? 0),
      etag: resp.headers.get("etag") ?? undefined,
      contentType: resp.headers.get("content-type") ?? undefined,
      lastModified: lastModified ? new Date(lastModified) : undefined,
    };
  }

  /** Whether an object exists on the disk (a HeadObject that maps 404 → false). */
  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  /**
   * Write an object to the disk via the S3-compatible API. Handles any size:
   * bodies at or below `multipartThreshold` (defaults to `partSize`, i.e.
   * 16 MiB) go through a single PutObject request; larger bodies are uploaded as
   * a multipart upload — split into `partSize` parts, uploaded with bounded
   * `concurrency` (default 4), and assembled. A failed part aborts the upload so
   * nothing is left half-staged. For manual control over the multipart
   * lifecycle, use the {@link multipart} namespace.
   *
   * Faster than exec for large files — no container overhead, no command-length
   * limits. Returns the entity tag the server assigned (a multipart upload's tag
   * is S3's `md5(concat(partMd5s))-N` form rather than a plain MD5).
   *
   * @param key      Path on the disk (e.g. "reports/2026-01/data.json")
   * @param body     Contents as a string, Uint8Array/Buffer, or ArrayBuffer
   * @param options  Either a content-type string, or {@link PutObjectOptions}
   *                 (`contentType`, `multipartThreshold`, `partSize`,
   *                 `concurrency`). Content type defaults to
   *                 "application/octet-stream".
   */
  async putObject(
    key: string,
    body: string | Uint8Array | ArrayBuffer,
    options?: string | PutObjectOptions,
  ): Promise<PutObjectResult> {
    const opts: PutObjectOptions = typeof options === "string" ? { contentType: options } : options ?? {};
    const contentType = opts.contentType ?? "application/octet-stream";
    const partSize = Math.max(opts.partSize ?? DEFAULT_PART_SIZE, MIN_PART_SIZE);
    const threshold = opts.multipartThreshold ?? partSize;
    const bytes = toBytes(body);

    if (bytes.length <= threshold) {
      const resp = await this._s3Request("PUT", key, { body, contentType });
      if (!resp.ok) {
        throw parseS3Error("PutObject", resp.status, resp.statusText, decodeText(resp.body));
      }
      return { etag: resp.headers.get("etag") ?? undefined };
    }

    return this._putMultipart(
      key,
      bytes,
      contentType,
      partSize,
      Math.max(1, opts.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY),
    );
  }

  /**
   * Upload a large body through the multipart lifecycle: split into `partSize`
   * parts, upload them with bounded concurrency, then complete — aborting the
   * upload if any part fails so nothing is left half-staged. @internal
   */
  private async _putMultipart(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    partSize: number,
    concurrency: number,
  ): Promise<PutObjectResult> {
    // Grow the part size if the body would otherwise need more than the server's
    // 10,000-part cap — otherwise the upload would fail at `complete`.
    const effectivePartSize = effectiveUploadPartSize(bytes.length, partSize);
    const mp = this.multipart;
    const upload = await mp.create(key, contentType);
    try {
      const partCount = Math.ceil(bytes.length / effectivePartSize);
      const parts: UploadPart[] = new Array(partCount);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const index = next++;
          if (index >= partCount) return;
          const start = index * effectivePartSize;
          const slice = bytes.subarray(start, Math.min(start + effectivePartSize, bytes.length));
          parts[index] = await mp.uploadPart(key, upload.uploadId, index + 1, slice);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, worker));
      const done = await mp.complete(key, upload.uploadId, parts);
      return { etag: done.etag };
    } catch (err) {
      // Don't let a cleanup failure mask the original error.
      await mp.abort(key, upload.uploadId).catch(() => {});
      throw err;
    }
  }

  /**
   * Append bytes to an object via the S3-compatible PutObject append extension
   * (`?append=true`). If the object already exists the bytes are appended to it;
   * if it doesn't, it is created. Returns the entity tag of the full object
   * after the append.
   *
   * Each call may append at most 1 MiB — the server rejects a larger body with
   * `EntityTooLarge`. To grow an object past that, append in chunks (or use
   * {@link putObject} for a one-shot large write).
   *
   * Unlike most operations this is NOT auto-retried on a transient error:
   * append isn't idempotent, so retrying a succeeded-but-unacknowledged append
   * would duplicate the bytes. On a transient failure, re-append yourself only
   * after confirming the object's size.
   *
   * @param key          Path on the disk (e.g. "logs/app.log")
   * @param body         Bytes to append (string, Uint8Array/Buffer, or ArrayBuffer)
   * @param contentType  MIME type, applied only when the object is newly created.
   */
  async appendObject(
    key: string,
    body: string | Uint8Array | ArrayBuffer,
    contentType = "application/octet-stream",
  ): Promise<PutObjectResult> {
    const resp = await this._s3Request("PUT", key, {
      body,
      contentType,
      query: { append: "true" },
      retry: false,
    });
    if (!resp.ok) {
      throw parseS3Error("AppendObject", resp.status, resp.statusText, decodeText(resp.body));
    }
    return { etag: resp.headers.get("etag") ?? undefined };
  }

  /**
   * Delete an object from the disk via the S3-compatible DeleteObject API.
   * Idempotent: deleting a key that doesn't exist resolves successfully, per
   * S3 semantics.
   *
   * @param key  Path on the disk (e.g. "project/dist/server.cjs")
   */
  async deleteObject(key: string): Promise<void> {
    const resp = await this._s3Request("DELETE", key);
    // DeleteObject is idempotent: a 404 for an absent key is not an error.
    if (!resp.ok && resp.status !== 404) {
      throw parseS3Error("DeleteObject", resp.status, resp.statusText, decodeText(resp.body));
    }
  }

  /**
   * List objects on the disk via the S3-compatible ListObjectsV2 API. By
   * default this follows continuation tokens until the listing is exhausted and
   * returns every matching key. Use `limit` to cap the total, `singlePage` for a
   * single request, or {@link listObjectsPages} to stream pages without loading
   * everything into memory.
   *
   * @param prefix  Only return keys beginning with this prefix (omit for all).
   * @param opts    Listing and pagination options.
   */
  async listObjects(prefix?: string, opts: ListObjectsOptions = {}): Promise<ListObjectsResult> {
    if (opts.singlePage) {
      return this._listObjectsPage(prefix, opts);
    }

    const objects: S3Object[] = [];
    const commonPrefixes: string[] = [];
    const seenPrefixes = new Set<string>();
    let echoedPrefix: string | undefined;
    let truncated = false;

    outer: for await (const page of this.listObjectsPages(prefix, opts)) {
      echoedPrefix = page.prefix;
      for (const cp of page.commonPrefixes) {
        if (!seenPrefixes.has(cp)) {
          seenPrefixes.add(cp);
          commonPrefixes.push(cp);
        }
      }
      for (const obj of page.objects) {
        if (opts.limit !== undefined && objects.length >= opts.limit) {
          truncated = true; // the cap cut the listing short — more may exist
          break outer;
        }
        objects.push(obj);
      }
    }

    return { objects, commonPrefixes, isTruncated: truncated, keyCount: objects.length, prefix: echoedPrefix };
  }

  /**
   * Yield ListObjectsV2 pages lazily, following continuation tokens. A
   * memory-friendly way to process a large listing without materializing it:
   *
   * ```ts
   * for await (const page of disk.listObjectsPages("logs/")) {
   *   for (const obj of page.objects) process(obj);
   * }
   * ```
   *
   * @param prefix  Only return keys beginning with this prefix (omit for all).
   * @param opts    Listing options (`limit` / `singlePage` are ignored here —
   *                control your own loop).
   */
  async *listObjectsPages(prefix?: string, opts: ListObjectsOptions = {}): AsyncGenerator<ListObjectsResult> {
    const seenTokens = new Set<string>();
    let continuationToken = opts.continuationToken;
    for (;;) {
      const page = await this._listObjectsPage(prefix, { ...opts, continuationToken });
      yield page;
      const next = page.isTruncated ? page.nextContinuationToken : undefined;
      // Stop at the end, or if the server returns a repeated token (no forward
      // progress) — never loop forever.
      if (!next || seenTokens.has(next)) break;
      seenTokens.add(next);
      continuationToken = next;
    }
  }

  /** Fetch a single ListObjectsV2 page. @internal */
  private async _listObjectsPage(prefix: string | undefined, opts: ListObjectsOptions): Promise<ListObjectsResult> {
    const query: Record<string, string | number> = { "list-type": 2 };
    if (prefix !== undefined) query.prefix = prefix;
    // Non-recursive (default) lists a single level via the "/" delimiter;
    // recursive omits the delimiter so all keys under the prefix are returned.
    if (!opts.recursive) query.delimiter = "/";
    if (opts.continuationToken !== undefined) query["continuation-token"] = opts.continuationToken;
    if (opts.startAfter !== undefined) query["start-after"] = opts.startAfter;

    const resp = await this._s3Request("GET", "", { query });
    if (!resp.ok) {
      throw parseS3Error("ListObjectsV2", resp.status, resp.statusText, decodeText(resp.body));
    }
    return parseListObjectsResult(decodeText(resp.body));
  }

  /**
   * Delete up to many objects in a single S3-compatible DeleteObjects request.
   * Unlike {@link deleteObject}, failures are reported per key rather than
   * thrown: the result's `deleted` lists the keys that were removed and
   * `errors` lists the ones that weren't (with the server's code/message). A
   * key that didn't exist still counts as deleted, per S3 semantics.
   *
   * The server caps a single request at 1000 keys; this method transparently
   * splits larger inputs into 1000-key batches and merges the results.
   *
   * @param keys  Object keys to delete.
   * @param opts  `quiet` suppresses the per-key success list server-side.
   */
  async deleteObjects(keys: string[], opts: DeleteObjectsOptions = {}): Promise<DeleteObjectsResult> {
    const deleted: string[] = [];
    const errors: DeleteObjectsError[] = [];
    for (let i = 0; i < keys.length; i += MAX_DELETE_OBJECTS_PER_REQUEST) {
      const batch = keys.slice(i, i + MAX_DELETE_OBJECTS_PER_REQUEST);
      const xml = buildDeleteObjectsXml(batch, opts.quiet ?? false);
      const resp = await this._s3Request("POST", "", {
        query: { delete: "" },
        body: xml,
        contentType: "application/xml",
      });
      if (!resp.ok) {
        throw parseS3Error("DeleteObjects", resp.status, resp.statusText, decodeText(resp.body));
      }
      const parsed = parseDeleteObjectsResult(decodeText(resp.body));
      deleted.push(...parsed.deleted);
      errors.push(...parsed.errors);
    }
    return { deleted, errors };
  }

  /**
   * The advanced, opt-in multipart-upload API. Drive the raw lifecycle
   * yourself — `create` → `uploadPart` → `complete` (or `abort`), plus
   * `listParts` / `listUploads`. Most callers don't need this: {@link putObject}
   * runs the whole lifecycle automatically for large bodies. Reach for it only
   * when you need manual control (e.g. uploading parts from separate processes),
   * and note you then own part-size, memory, and concurrency management.
   */
  get multipart(): DiskMultipart {
    return (this._multipart ??= new DiskMultipart(this.id, this._s3Request.bind(this)));
  }

  /**
   * Send a single request to the disk's S3-compatible endpoint. This reuses the
   * control-plane client purely for its credential and transport — the same
   * `Authorization` header is sent and verified by the same code server-side —
   * pointed at the S3 host. Returns the response status and fully-buffered body
   * so callers can inspect both regardless of the verb used.
   *
   * The S3 routes (`/{diskId}/{key}` for objects, `/{diskId}` for the bucket)
   * are not part of the typed control-plane API, so the path and per-request
   * options are passed untyped. An empty `key` targets the bucket itself (used
   * by listObjects).
   *
   * @internal
   */
  private async _s3Request(
    method: "GET" | "PUT" | "DELETE" | "HEAD" | "POST",
    key: string,
    opts: {
      body?: string | Uint8Array | ArrayBuffer;
      contentType?: string;
      query?: Record<string, string | number>;
      // Whether a transient failure may be retried. Defaults to true. Set false
      // for non-idempotent ops (CompleteMultipartUpload), where a retry after a
      // successful-but-unacknowledged completion returns a spurious NoSuchUpload.
      retry?: boolean;
    } = {},
  ): Promise<{ ok: boolean; status: number; statusText: string; headers: Headers; body: Uint8Array }> {
    if (!this._s3BaseUrl) {
      throw new Error(
        "S3 base URL not configured. Pass s3BaseUrl to new Archil({...}) or set ARCHIL_S3_BASE_URL.",
      );
    }

    const call = this._client[method] as unknown as (
      url: string,
      init: Record<string, unknown>,
    ) => Promise<{ error?: unknown; response: Response }>;

    // Percent-encode each key segment so reserved characters (?, #, %, space,
    // …) can't be reinterpreted as query/fragment or break URL parsing. Encode
    // per-segment to preserve the `/` path separators that model the key's
    // directory structure.
    const trimmedKey = key.replace(/^\//, "");
    const encodedKey = trimmedKey
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const path = encodedKey ? `/${this.id}/${encodedKey}` : `/${this.id}`;
    const init: Record<string, unknown> = {
      baseUrl: this._s3BaseUrl,
      parseAs: "stream",
      ...(opts.query ? { params: { query: opts.query } } : {}),
      // fetch accepts string / Uint8Array / ArrayBuffer bodies directly; pass it
      // through unchanged (no Node Buffer in the data path). Bodies are fully
      // buffered (never streams), so re-sending one on a retry is safe.
      ...(opts.body !== undefined ? { body: opts.body, bodySerializer: (b: unknown) => b } : {}),
      ...(opts.contentType ? { headers: { "Content-Type": opts.contentType } } : {}),
    };

    // GET (object reads, listings) and POST (multipart Initiate/Complete,
    // DeleteObjects) carry an XML/data body we need; PUT/DELETE/HEAD don't.
    const hasBody = method === "GET" || method === "POST";

    // Retry transient failures (gateway 5xx / 429 / network errors) with
    // jittered exponential backoff. Bodies are buffered, so re-sending is safe.
    // Most ops are safe to retry, but the non-idempotent ones opt out via
    // `retry: false`: CompleteMultipartUpload (a retry after a
    // successful-but-unacknowledged complete returns a spurious NoSuchUpload)
    // and appendObject (a retry would duplicate the appended bytes).
    const maxRetries = opts.retry === false ? 0 : MAX_S3_RETRIES;
    for (let attempt = 0; ; attempt++) {
      let error: unknown;
      let response: Response;
      try {
        ({ error, response } = await call(path, init));
      } catch (transportError) {
        if (attempt < maxRetries) {
          await sleep(s3RetryDelayMs(attempt));
          continue;
        }
        throw transportError;
      }

      if (!response.ok) {
        if (isTransientS3Status(response.status) && attempt < maxRetries) {
          // Release the response before retrying so the underlying connection
          // returns to the pool now rather than at GC. (openapi-fetch already
          // reads error bodies, but cancel here is the safe, explicit guard.)
          await response.body?.cancel().catch(() => {});
          await sleep(s3RetryDelayMs(attempt));
          continue;
        }
        // openapi-fetch consumes a non-2xx body into `error` (the raw text, or
        // parsed JSON if it happens to parse) — for the S3 gateway that's the
        // XML <Error> document. Surface it as the response body so callers see
        // the gateway's detail, not just a status line.
        const message = typeof error === "string" ? error : error ? JSON.stringify(error) : "";
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: new TextEncoder().encode(message),
        };
      }

      const bytes = hasBody ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array(0);
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: bytes,
      };
    }
  }

  /**
   * Connect to this disk's data plane via the native ArchilClient.
   *
   * Requires the native module to be available (platform-specific .node binary).
   */
  async mount(opts?: MountOptions): Promise<unknown> {
    let ArchilClient: any;
    try {
      // The native addon is a Node-only, platform-specific binary. Load it via
      // a runtime dynamic import with a non-literal specifier so browser
      // bundlers leave it as a runtime import rather than trying to resolve it
      // — that keeps the rest of the SDK bundleable for the browser, where
      // mount() is unavailable but every REST/S3 method still works.
      const nativeSpecifier = "@archildata/native";
      const native: any = await import(nativeSpecifier);
      ArchilClient = native.ArchilClient ?? native.default?.ArchilClient;
      if (!ArchilClient) {
        throw new Error("@archildata/native did not export ArchilClient");
      }
    } catch {
      throw new Error(
        "Native client not available. Install @archildata/native " +
          "(platform-specific binary) or use ArchilClient.connect() directly. " +
          "mount() is not supported in browsers.",
      );
    }

    return ArchilClient.connect({
      region: this._archilRegion,
      diskName: `${this.organization}/${this.name}`,
      authToken: opts?.authToken,
      logLevel: opts?.logLevel,
      serverAddress: opts?.serverAddress,
      insecure: opts?.insecure,
    });
  }
}

/**
 * The advanced, opt-in multipart-upload namespace, reached via {@link Disk.multipart}.
 * Drives the raw S3 multipart lifecycle — `create` → `uploadPart` → `complete`
 * (or `abort`), plus `listParts` / `listUploads`. Prefer {@link Disk.putObject},
 * which runs this lifecycle automatically for large bodies; use this only when
 * you need manual control, in which case you own part-size, memory, and
 * concurrency management.
 */
export class DiskMultipart {
  /** @internal */
  constructor(
    private readonly diskId: string,
    private readonly s3Request: S3RequestFn,
  ) {}

  /**
   * Start a multipart upload (CreateMultipartUpload) and return its `uploadId`.
   *
   * @param key          Path on the disk the finished object will live at.
   * @param contentType  MIME type to store the object with.
   */
  async create(key: string, contentType?: string): Promise<MultipartUpload> {
    const resp = await this.s3Request("POST", key, { query: { uploads: "" }, contentType });
    if (!resp.ok) {
      throw parseS3Error("CreateMultipartUpload", resp.status, resp.statusText, decodeText(resp.body));
    }
    const root = (parseXml(decodeText(resp.body)).InitiateMultipartUploadResult ?? {}) as Record<string, unknown>;
    const uploadId = optionalString(root.UploadId);
    if (!uploadId) {
      throw new ArchilS3Error({
        operation: "CreateMultipartUpload",
        statusCode: resp.status,
        message: "response did not contain an UploadId",
        raw: decodeText(resp.body),
      });
    }
    return {
      uploadId,
      key: optionalString(root.Key) ?? key,
      bucket: optionalString(root.Bucket) ?? this.diskId,
    };
  }

  /**
   * Upload one part (UploadPart) and return its entity tag, which you must
   * collect (with its part number) and pass to {@link complete}. Every part
   * except the last must be at least 5 MiB.
   *
   * @param key         The upload's object key.
   * @param uploadId    The id from {@link create}.
   * @param partNumber  1-based part number (1..=10000).
   * @param body        Part contents as a string, Uint8Array/Buffer, or ArrayBuffer.
   */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: string | Uint8Array | ArrayBuffer,
  ): Promise<UploadPart> {
    const resp = await this.s3Request("PUT", key, { query: { uploadId, partNumber }, body });
    if (!resp.ok) {
      throw parseS3Error("UploadPart", resp.status, resp.statusText, decodeText(resp.body));
    }
    return { partNumber, etag: resp.headers.get("etag") ?? "" };
  }

  /**
   * Finish a multipart upload (CompleteMultipartUpload), assembling the listed
   * parts into one object. Parts are sorted by part number before submission
   * (the server requires strictly-increasing order).
   *
   * Unlike the other operations this is NOT auto-retried on a transient error:
   * the gateway isn't idempotent for completion, so a retry after a
   * successful-but-unacknowledged complete would return a spurious NoSuchUpload.
   * On a transient failure, re-drive completion yourself only after confirming
   * the object isn't already present.
   *
   * @param key       The upload's object key.
   * @param uploadId  The id from {@link create}.
   * @param parts     The `{ partNumber, etag }` pairs from {@link uploadPart}.
   */
  async complete(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<CompletedMultipartUpload> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const xml = buildCompleteMultipartUploadXml(sorted);
    const resp = await this.s3Request("POST", key, {
      query: { uploadId },
      body: xml,
      contentType: "application/xml",
      retry: false,
    });
    if (!resp.ok) {
      throw parseS3Error("CompleteMultipartUpload", resp.status, resp.statusText, decodeText(resp.body));
    }
    const root = (parseXml(decodeText(resp.body)).CompleteMultipartUploadResult ?? {}) as Record<string, unknown>;
    return {
      etag: optionalString(root.ETag),
      location: optionalString(root.Location),
      bucket: optionalString(root.Bucket),
      key: optionalString(root.Key),
    };
  }

  /**
   * Abort a multipart upload (AbortMultipartUpload), discarding every staged
   * part. Idempotent against an upload that's already gone (404 / NoSuchUpload
   * resolves successfully).
   *
   * @param key       The upload's object key.
   * @param uploadId  The id from {@link create}.
   */
  async abort(key: string, uploadId: string): Promise<void> {
    const resp = await this.s3Request("DELETE", key, { query: { uploadId } });
    if (!resp.ok && resp.status !== 404) {
      throw parseS3Error("AbortMultipartUpload", resp.status, resp.statusText, decodeText(resp.body));
    }
  }

  /**
   * List the parts already uploaded for an in-progress upload (ListParts).
   * Returns a single page; follow `nextPartNumberMarker` (when `isTruncated`)
   * to page through the rest.
   *
   * @param key       The upload's object key.
   * @param uploadId  The id from {@link create}.
   * @param opts      `maxParts` / `partNumberMarker` pagination controls.
   */
  async listParts(key: string, uploadId: string, opts: ListPartsOptions = {}): Promise<PartListing> {
    const query: Record<string, string | number> = { uploadId };
    if (opts.maxParts !== undefined) query["max-parts"] = opts.maxParts;
    if (opts.partNumberMarker !== undefined) query["part-number-marker"] = opts.partNumberMarker;
    const resp = await this.s3Request("GET", key, { query });
    if (!resp.ok) {
      throw parseS3Error("ListParts", resp.status, resp.statusText, decodeText(resp.body));
    }
    return parseListPartsResult(decodeText(resp.body));
  }

  /**
   * List in-progress multipart uploads on the disk (ListMultipartUploads).
   * Returns a single page; follow `nextKeyMarker` / `nextUploadIdMarker` (when
   * `isTruncated`) for the rest.
   *
   * @param opts  Prefix/delimiter filter and pagination markers.
   */
  async listUploads(opts: ListMultipartUploadsOptions = {}): Promise<MultipartUploadListing> {
    const query: Record<string, string | number> = { uploads: "" };
    if (opts.prefix !== undefined) query.prefix = opts.prefix;
    if (opts.delimiter !== undefined) query.delimiter = opts.delimiter;
    if (opts.keyMarker !== undefined) query["key-marker"] = opts.keyMarker;
    if (opts.uploadIdMarker !== undefined) query["upload-id-marker"] = opts.uploadIdMarker;
    if (opts.maxUploads !== undefined) query["max-uploads"] = opts.maxUploads;
    const resp = await this.s3Request("GET", "", { query });
    if (!resp.ok) {
      throw parseS3Error("ListMultipartUploads", resp.status, resp.statusText, decodeText(resp.body));
    }
    return parseListMultipartUploadsResult(decodeText(resp.body));
  }
}

/** S3's per-request cap on DeleteObjects keys; larger inputs are batched. */
const MAX_DELETE_OBJECTS_PER_REQUEST = 1000;
/** Automatic retries for a transient S3 failure (5xx / 429 / network error). */
const MAX_S3_RETRIES = 3;
/** Base backoff for S3 retries (ms); grows exponentially, then full-jittered. */
const S3_RETRY_BASE_MS = 100;
/** Ceiling for a single retry backoff (ms). */
const S3_RETRY_CAP_MS = 2000;

/**
 * Statuses worth retrying: throttling (429) and the gateway's transient 5xx
 * (e.g. a journal-commit timeout surfaced as 500). 4xx other than 429 are
 * caller errors and never retried.
 */
function isTransientS3Status(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Full-jittered exponential backoff for retry `attempt` (0-based). */
function s3RetryDelayMs(attempt: number): number {
  const ceiling = Math.min(S3_RETRY_CAP_MS, S3_RETRY_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** S3's minimum size for every multipart part but the last (5 MiB). */
const MIN_PART_SIZE = 5 * 1024 * 1024;
/** Default part size {@link Disk.putObject} uses on the multipart path (16 MiB). */
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
/** Default number of parts {@link Disk.putObject} uploads in parallel. */
const DEFAULT_UPLOAD_CONCURRENCY = 4;
/** The server's cap on parts in a single multipart upload (MAX_PARTS_PER_UPLOAD). */
const MAX_PARTS_PER_UPLOAD = 10_000;

/**
 * Choose the part size for a `totalBytes` multipart upload. Returns
 * `requestedPartSize` unless splitting at that size would exceed the server's
 * 10,000-part cap, in which case it grows the part size (rounded up to a whole
 * MiB) so the body fits in ≤ 10,000 parts — mirroring boto3's chunk-size
 * adjustment. Parts only ever get larger, so they stay above the 5 MiB floor.
 */
export function effectiveUploadPartSize(totalBytes: number, requestedPartSize: number): number {
  if (Math.ceil(totalBytes / requestedPartSize) <= MAX_PARTS_PER_UPLOAD) {
    return requestedPartSize;
  }
  const MiB = 1024 * 1024;
  const needed = Math.ceil(totalBytes / MAX_PARTS_PER_UPLOAD);
  return Math.ceil(needed / MiB) * MiB;
}

/** Normalize an upload body to bytes so it can be sized and sliced into parts. */
function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

/** Escape text for safe inclusion in XML element content. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build a `<Delete>` request body for the DeleteObjects API. */
function buildDeleteObjectsXml(keys: string[], quiet: boolean): string {
  const objects = keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("");
  const quietTag = quiet ? "<Quiet>true</Quiet>" : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Delete>${objects}${quietTag}</Delete>`;
}

/** Build a `<CompleteMultipartUpload>` request body from the uploaded parts. */
function buildCompleteMultipartUploadXml(parts: UploadPart[]): string {
  const body = parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${body}</CompleteMultipartUpload>`;
}

/** Coerce a parser value that may be a single object or an array into an array. */
function asArray(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as Array<Record<string, unknown>>;
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : Number(value);
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function optionalDate(value: unknown): Date | undefined {
  return value === undefined || value === null ? undefined : new Date(String(value));
}

/** Decode response bytes to a UTF-8 string (used for XML error/result bodies). */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Parse an S3 ListObjectsV2 `<ListBucketResult>` XML document. */
function parseListObjectsResult(xml: string): ListObjectsResult {
  const root = (parseXml(xml).ListBucketResult ?? {}) as Record<string, unknown>;

  const contents = (root.Contents ?? []) as Array<Record<string, unknown>>;
  const objects: S3Object[] = contents.map((c) => ({
    key: String(c.Key ?? ""),
    size: Number(c.Size ?? 0),
    etag: optionalString(c.ETag),
    lastModified: optionalDate(c.LastModified),
  }));

  const commonPrefixes = ((root.CommonPrefixes ?? []) as Array<Record<string, unknown>>)
    .map((cp) => optionalString(cp.Prefix))
    .filter((p): p is string => p !== undefined);

  return {
    objects,
    commonPrefixes,
    isTruncated: root.IsTruncated === "true" || root.IsTruncated === true,
    nextContinuationToken: optionalString(root.NextContinuationToken),
    keyCount: root.KeyCount !== undefined ? Number(root.KeyCount) : objects.length,
    prefix: optionalString(root.Prefix),
  };
}

function xmlIsTruncated(value: unknown): boolean {
  return value === "true" || value === true;
}

/** Parse an S3 DeleteObjects `<DeleteResult>` XML document. */
function parseDeleteObjectsResult(xml: string): DeleteObjectsResult {
  const root = (parseXml(xml).DeleteResult ?? {}) as Record<string, unknown>;
  const deleted = asArray(root.Deleted)
    .map((d) => optionalString(d.Key))
    .filter((k): k is string => k !== undefined);
  const errors: DeleteObjectsError[] = asArray(root.Error).map((e) => ({
    key: String(e.Key ?? ""),
    code: optionalString(e.Code),
    message: optionalString(e.Message),
  }));
  return { deleted, errors };
}

/** Parse an S3 `<ListPartsResult>` XML document. */
function parseListPartsResult(xml: string): PartListing {
  const root = (parseXml(xml).ListPartsResult ?? {}) as Record<string, unknown>;
  const parts: PartInfo[] = asArray(root.Part).map((p) => ({
    partNumber: Number(p.PartNumber ?? 0),
    etag: optionalString(p.ETag),
    size: Number(p.Size ?? 0),
    lastModified: optionalDate(p.LastModified),
  }));
  return {
    bucket: optionalString(root.Bucket),
    key: optionalString(root.Key),
    uploadId: optionalString(root.UploadId),
    parts,
    isTruncated: xmlIsTruncated(root.IsTruncated),
    partNumberMarker: Number(root.PartNumberMarker ?? 0),
    nextPartNumberMarker: optionalNumber(root.NextPartNumberMarker),
    maxParts: Number(root.MaxParts ?? parts.length),
  };
}

/** Parse an S3 `<ListMultipartUploadsResult>` XML document. */
function parseListMultipartUploadsResult(xml: string): MultipartUploadListing {
  const root = (parseXml(xml).ListMultipartUploadsResult ?? {}) as Record<string, unknown>;
  const uploads: MultipartUploadSummary[] = asArray(root.Upload).map((u) => ({
    key: String(u.Key ?? ""),
    uploadId: String(u.UploadId ?? ""),
    initiated: optionalDate(u.Initiated),
  }));
  const commonPrefixes = asArray(root.CommonPrefixes)
    .map((cp) => optionalString(cp.Prefix))
    .filter((p): p is string => p !== undefined);
  return {
    bucket: optionalString(root.Bucket),
    uploads,
    commonPrefixes,
    isTruncated: xmlIsTruncated(root.IsTruncated),
    keyMarker: optionalString(root.KeyMarker),
    uploadIdMarker: optionalString(root.UploadIdMarker),
    nextKeyMarker: optionalString(root.NextKeyMarker),
    nextUploadIdMarker: optionalString(root.NextUploadIdMarker),
    prefix: optionalString(root.Prefix),
    delimiter: optionalString(root.Delimiter),
    maxUploads: optionalNumber(root.MaxUploads),
  };
}
