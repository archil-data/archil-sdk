import createClientDefault, { type Client } from "openapi-fetch";
import type { paths } from "@archildata/api-types";
import { ArchilApiError } from "./errors.js";
import { resolveBaseUrl } from "./regions.js";
import { USER_AGENT } from "./version.js";

// openapi-fetch ships dual ESM/CJS builds. In our ESM output the default import
// is the factory function directly; in our CJS output (dist/index.cjs) Node's
// CJS interop can hand back the whole module namespace instead, so the real
// factory is nested under `.default`. Unwrap it when the import isn't directly
// callable. Without this, `require("disk")` throws "default is not a function".
const createClient = (
  typeof createClientDefault === "function"
    ? createClientDefault
    : (createClientDefault as { default: typeof createClientDefault }).default
);

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  apiKey: string;
  region: string;
  baseUrl?: string;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl ?? resolveBaseUrl(opts.region);
  return createClient<paths>({
    baseUrl,
    headers: {
      Authorization: `key-${opts.apiKey.replace(/^key-/, '')}`,
      // Identifies the JS SDK (and its version) to the control plane. Honored
      // by Node's fetch; browsers treat User-Agent as a forbidden header and
      // drop it, which is fine — the SDK's primary use is server-side.
      "User-Agent": USER_AGENT,
    },
  });
}

/**
 * Unwrap the API envelope: return data on success, throw ArchilApiError on failure.
 */
export async function unwrap<T>(
  promise: Promise<{ data?: { success: boolean; data?: T; error?: string }; error?: unknown; response: Response }>,
): Promise<T> {
  return (await unwrapPage(promise)).data;
}

/**
 * Unwrap a paginated list envelope: like {@link unwrap}, but also surface the
 * envelope's `nextCursor` (undefined on the last page or from a server that
 * doesn't paginate).
 */
export async function unwrapPage<T>(
  promise: Promise<{
    data?: { success: boolean; data?: T; error?: string; nextCursor?: string };
    error?: unknown;
    response: Response;
  }>,
): Promise<{ data: T; nextCursor?: string }> {
  const { data: body, error, response } = await promise;

  if (error || !body) {
    const errBody = error as { error?: string } | undefined;
    throw new ArchilApiError(
      errBody?.error ?? `API request failed with status ${response.status}`,
      response.status,
    );
  }

  if (!body.success) {
    throw new ArchilApiError(
      (body as unknown as { error?: string }).error ?? "Unknown API error",
      response.status,
    );
  }

  return { data: body.data as T, nextCursor: body.nextCursor };
}

/**
 * Unwrap an API response that has no data payload (e.g., delete operations).
 */
export async function unwrapEmpty(
  promise: Promise<{ data?: { success: boolean; error?: string }; error?: unknown; response: Response }>,
): Promise<void> {
  const { data: body, error, response } = await promise;

  if (error || !body) {
    const errBody = error as { error?: string } | undefined;
    throw new ArchilApiError(
      errBody?.error ?? `API request failed with status ${response.status}`,
      response.status,
    );
  }

  if (!body.success) {
    throw new ArchilApiError(
      body.error ?? "Unknown API error",
      response.status,
    );
  }
}
