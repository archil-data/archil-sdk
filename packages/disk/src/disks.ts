import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import { Disk } from "./disk.js";
import type { AuthorizedUser, CreateDiskRequest, DiskResponse } from "./types.js";

export interface ListDisksOptions {
  limit?: number;
  cursor?: string;
  name?: string;
}

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

  async list(opts?: ListDisksOptions): Promise<Disk[]> {
    const data = await unwrap(
      this._client.GET("/api/disks", {
        params: { query: { limit: opts?.limit, cursor: opts?.cursor, name: opts?.name } },
      }),
    );
    return (data as DiskResponse[]).map(
      (d) => new Disk(d, this._client, this._region, this._s3BaseUrl),
    );
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
