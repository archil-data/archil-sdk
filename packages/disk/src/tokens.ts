import type { ApiClient } from "./client.js";
import { unwrap, unwrapEmpty } from "./client.js";
import type { CreateApiTokenRequest, ApiTokenResponse } from "./types.js";

export interface ListTokensOptions {
  limit?: number;
  cursor?: string;
}

export class Tokens {
  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(client: ApiClient) {
    this._client = client;
  }

  async list(opts?: ListTokensOptions): Promise<ApiTokenResponse[]> {
    const data = await unwrap(
      this._client.GET("/api/tokens", {
        params: { query: { limit: opts?.limit, cursor: opts?.cursor } },
      }),
    );
    return (data as { tokens?: ApiTokenResponse[] }).tokens ?? [];
  }

  async create(
    req: CreateApiTokenRequest,
  ): Promise<ApiTokenResponse & { token?: string }> {
    const data = await unwrap(
      this._client.POST("/api/tokens", { body: req }),
    );
    return data as ApiTokenResponse & { token?: string };
  }

  async delete(id: string): Promise<void> {
    await unwrapEmpty(
      this._client.DELETE("/api/tokens/{id}", {
        params: { path: { id } },
      }),
    );
  }
}
