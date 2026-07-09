import type { ApiClient } from "./client.js";
import { unwrap, unwrapPage } from "./client.js";
import { Disk } from "./disk.js";
import type { AuthorizedUser, CreateDiskRequest, DiskResponse } from "./types.js";

export interface ListDisksOptions {
  /** Cap on the total number of disks returned. */
  limit?: number;
  /** Resume listing from a previous page's `nextCursor`. */
  cursor?: string;
  name?: string;
}

export interface DiskListPage {
  disks: Disk[];
  /**
   * Set when more disks remain beyond this page; pass it back as `cursor` to
   * fetch the next one. Undefined on the last page.
   */
  nextCursor?: string;
}

/** Server-side maximum page size for GET /api/disks. */
const DISK_PAGE_LIMIT = 100;

export interface CreateDiskResult {
  disk: Disk;
  token: string | null;
  tokenIdentifier: string | null;
  authorizedUsers: AuthorizedUser[];
}

export class Disks {
  /** @internal */
  private readonly _client: ApiClient;
  /** @internal */
  private readonly _region: string;
  /** @internal */
  private readonly _s3BaseUrl?: string;

  /** @internal */
  constructor(client: ApiClient, region: string, s3BaseUrl?: string) {
    this._client = client;
    this._region = region;
    this._s3BaseUrl = s3BaseUrl;
  }

  /**
   * List the account's disks. Fetches in cursor-driven pages (bounded server
   * work per request) and follows `nextCursor` until exhausted, so the result
   * is complete even for very large accounts. Use `limit` to cap the total, or
   * {@link listPage} to walk pages yourself.
   */
  async list(opts?: ListDisksOptions): Promise<Disk[]> {
    if (opts?.name !== undefined) {
      return (await this.listPage(opts)).disks;
    }

    const limit = opts?.limit;
    let cursor = opts?.cursor;
    const disks: Disk[] = [];
    for (;;) {
      const remaining = limit === undefined ? undefined : limit - disks.length;
      if (remaining !== undefined && remaining <= 0) {
        return disks;
      }
      const pageLimit = remaining === undefined ? DISK_PAGE_LIMIT : Math.min(remaining, DISK_PAGE_LIMIT);
      const page = await this.listPage({ limit: pageLimit, cursor });
      // A server that predates pagination ignores `limit` and returns the full
      // list; slice so the cap still holds.
      disks.push(...(remaining === undefined ? page.disks : page.disks.slice(0, remaining)));
      // A repeated cursor means no forward progress — never loop forever.
      if (!page.nextCursor || page.nextCursor === cursor) {
        return disks;
      }
      cursor = page.nextCursor;
    }
  }

  /**
   * Fetch a single page of disks. `nextCursor` on the result resumes the
   * listing (it can also be persisted, e.g. across requests of a paginated UI).
   */
  async listPage(opts?: ListDisksOptions): Promise<DiskListPage> {
    const { data, nextCursor } = await unwrapPage(
      this._client.GET("/api/disks", {
        params: { query: { limit: opts?.limit, cursor: opts?.cursor, name: opts?.name } },
      }),
    );
    // `?? []`: an empty account serializes as JSON null (Go nil slice).
    const disks = ((data ?? []) as DiskResponse[]).map(
      (d) => new Disk(d, this._client, this._region, this._s3BaseUrl),
    );
    return nextCursor ? { disks, nextCursor } : { disks };
  }

  async get(id: string): Promise<Disk> {
    const data = await unwrap(
      this._client.GET("/api/disks/{id}", {
        params: { path: { id } },
      }),
    );
    return new Disk(data as DiskResponse, this._client, this._region, this._s3BaseUrl);
  }

  /**
   * Create a new disk with an auto-generated mount token.
   *
   * Returns the Disk, the one-time token (save it — it cannot be retrieved
   * again), and the token identifier for later management.
   */
  async create(req: CreateDiskRequest): Promise<CreateDiskResult> {
    const created = await unwrap(
      this._client.POST("/api/disks", { body: req }),
    );
    const resp = created as {
      diskId?: string;
      authorizedUsers?: AuthorizedUser[];
    };
    if (!resp.diskId) {
      throw new Error("API returned success but no diskId");
    }

    const authorizedUsers = resp.authorizedUsers ?? [];
    const tokenUser = authorizedUsers.find((u) => u.token);

    const disk = await this.get(resp.diskId);
    return {
      disk,
      token: tokenUser?.token ?? null,
      tokenIdentifier: tokenUser?.identifier ?? null,
      authorizedUsers,
    };
  }
}
