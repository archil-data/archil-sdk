import createClientDefault, { type Client } from "openapi-fetch";
import type { paths } from "@archildata/api-types";
import type { Dispatcher } from "undici";
import type { ConnectionOptions } from "node:tls";
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

type ApiPaths = paths & {
  "/api/disks/{id}/connect": {
    post: {
      parameters: { path: { id: string } };
      responses: paths["/api/sandboxes"]["post"]["responses"];
    };
  };
};

export type ApiClient = Client<ApiPaths>;

export interface ArchilTlsOptions {
  /**
   * Trusted PEM CA certificates for this client's control-plane and S3 requests
   * (Node.js only). Replaces Node's default CA list; include those certificates
   * explicitly to retain them. Certificate and hostname verification stay enabled.
   */
  ca?: ConnectionOptions["ca"];
}

export interface ApiClientOptions {
  apiKey: string;
  region: string;
  baseUrl?: string;
  tls?: ArchilTlsOptions;
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

// Begin resolving the Node transport as soon as the SDK module loads, just as
// a static Node import would. Keeping the specifier non-literal preserves the
// browser build, while eager resolution keeps module-loading work out of the
// first API request's latency.
const undiciSpecifier = "undici";
const undiciModule = isNodeRuntime()
  ? import(undiciSpecifier) as Promise<typeof import("undici")>
  : undefined;

type Undici = typeof import("undici");

const CONTROL_PLANE_CONNECTIONS = 1;
// ALBs close a connection idle for 60 s and do not count HTTP/2 PING frames as
// activity, so retire idle sessions first instead of racing that close.
const IDLE_SESSION_TIMEOUT_MS = 30_000;

function isAsyncIterableBody(
  body: Dispatcher.DispatchOptions["body"],
): body is Dispatcher.DispatchOptions["body"] & AsyncIterable<Uint8Array | string> {
  return body != null
    && typeof body === "object"
    && Symbol.asyncIterator in body;
}

async function bufferBody(body: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Undici replays a request that a GOAWAY refused (its stream id is above the
// frame's lastStreamID, so the server never processed it) only when the body is
// a Buffer or Blob, but fetch() hands it a streaming async iterable. Buffer the
// already-bounded body so refused control-plane requests, POSTs included, are
// replayed on a fresh session instead of failing.
export const bufferRequestBodies: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (
  options,
  handler,
) => {
  if (!isAsyncIterableBody(options.body)) return dispatch(options, handler);

  void bufferBody(options.body).then(
    (body) => dispatch({ ...options, body }, handler),
    (error: unknown) => handler.onResponseError?.({
      aborted: false,
      paused: false,
      reason: null,
      abort() {},
      pause() {},
      resume() {},
    }, error instanceof Error ? error : new Error(String(error))),
  );
  return true;
};

// Node's global fetch negotiates HTTP/1.1 even when the control plane
// advertises HTTP/2, and its bundled Undici cannot drive an Undici 8
// dispatcher, so control-plane and S3 requests go through Undici's own fetch
// over one lazily initialized HTTP/2 dispatcher per origin and credential,
// shared by every client in this JavaScript process. It opens a single session
// on demand and multiplexes concurrent requests over it, up to the stream limit
// the server advertises. CA settings must also match: TLS verification happens
// when a connection is established, so reusing it must not let a client
// inherit another client's trust.
interface PooledTransport {
  fetch: Undici["fetch"];
  dispatcher: Dispatcher;
}

const sharedTransports = new Map<string, Promise<PooledTransport>>();

function dispatcherKey(baseUrl: string, apiKey: string, ca?: Buffer[]): string {
  return JSON.stringify([new URL(baseUrl).origin, apiKey, ca?.map((cert) => cert.toString("base64"))]);
}

function getSharedTransport(key: string, ca?: Buffer[]): Promise<PooledTransport> {
  const existing = sharedTransports.get(key);
  if (existing) return existing;

  const transport = (async () => {
    if (!undiciModule) throw new Error("The pooled control-plane transport requires Node.js");
    const { Agent, fetch } = await undiciModule;
    const dispatcher = new Agent({
      allowH2: true,
      connections: CONTROL_PLANE_CONNECTIONS,
      keepAliveTimeout: IDLE_SESSION_TIMEOUT_MS,
      ...(ca === undefined ? {} : { connect: { ca } }),
    }).compose(bufferRequestBodies);
    return { fetch, dispatcher };
  })();

  sharedTransports.set(key, transport);
  void transport.catch(() => {
    // A transient module/initialization failure should not poison this pool
    // key permanently; let the next request retry initialization.
    if (sharedTransports.get(key) === transport) sharedTransports.delete(key);
  });
  return transport;
}

function createPooledFetch(
  baseUrl: string,
  apiKey: string,
  tls?: ArchilTlsOptions,
): ((request: Request) => Promise<Response>) | undefined {
  if (!isNodeRuntime()) {
    if (tls?.ca !== undefined) throw new Error("Custom TLS CAs require Node.js");
    return undefined;
  }

  // Caller-owned arrays and buffers must not change a client's trust or pool identity.
  const ca = tls?.ca === undefined
    ? undefined
    : (Array.isArray(tls.ca) ? tls.ca : [tls.ca]).map((cert) => Buffer.from(cert));
  const key = dispatcherKey(baseUrl, apiKey, ca);

  return async (request: Request): Promise<Response> => {
    const { fetch, dispatcher } = await getSharedTransport(key, ca);
    // openapi-fetch builds the global Request, which Undici's fetch does not
    // accept as input, so hand over its parts. SDK request bodies are bounded.
    const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
    const response = await fetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body,
      redirect: request.redirect,
      signal: request.signal,
      dispatcher,
    });
    // Undici's Response is the web class Node exposes; only its typings differ.
    return response as unknown as Response;
  };
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl ?? resolveBaseUrl(opts.region);
  const apiKey = `key-${opts.apiKey.replace(/^key-/, '')}`;
  return createClient<ApiPaths>({
    baseUrl,
    fetch: createPooledFetch(baseUrl, apiKey, opts.tls),
    headers: {
      Authorization: apiKey,
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

  if (!error && response.status === 204) return;

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
