import createClientDefault, { type Client } from "openapi-fetch";
import type { paths } from "@archildata/api-types";
import type { Dispatcher } from "undici";
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

const CONTROL_PLANE_CONNECTIONS = 1;
const CONTROL_PLANE_CONCURRENT_STREAMS = 100;

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

// Undici deliberately serializes non-idempotent requests and streaming request
// bodies, including the async iterable created internally for a fetch() POST.
// The control-plane API needs POSTs (notably disk exec) to share HTTP/2 sessions,
// so buffer the already-bounded request body and opt it into multiplexing. Guard
// onConnect so Undici can never replay a request that reached a socket: a dropped
// shared session fails in-flight operations instead of potentially running an
// exec or another mutation twice.
export const multiplexHttp2Requests: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (
  options,
  handler,
) => {
  let requestStarted = false;
  const guardedHandler: Dispatcher.DispatchHandler = {
    onRequestStart(controller, context) {
      if (requestStarted) {
        controller.abort(new Error("Archil control-plane requests are not replayed after a connection failure"));
        return;
      }
      requestStarted = true;
      handler.onRequestStart?.(controller, context);
    },
    onRequestUpgrade: handler.onRequestUpgrade?.bind(handler),
    onResponseStart: handler.onResponseStart?.bind(handler),
    onResponseData: handler.onResponseData?.bind(handler),
    onResponseEnd: handler.onResponseEnd?.bind(handler),
    onResponseError: handler.onResponseError?.bind(handler),
  };

  const dispatchBody = (body: Dispatcher.DispatchOptions["body"]): boolean => dispatch({
    ...options,
    body,
    idempotent: true,
  }, guardedHandler);

  if (!isAsyncIterableBody(options.body)) return dispatchBody(options.body);

  void bufferBody(options.body).then(
    dispatchBody,
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

// Every Archil instance used to delegate to Node's default global fetch
// dispatcher. That dispatcher currently negotiates HTTP/1.1, even when the
// control plane advertises HTTP/2, and a burst of independently constructed
// clients therefore creates substantial connection pressure. Keep one lazily
// initialized HTTP/2-capable dispatcher per control-plane origin and credential,
// shared by every client in this JavaScript process. It opens a single session
// on demand, then Undici multiplexes concurrent requests over that session.
const sharedDispatchers = new Map<string, Promise<Dispatcher>>();

function dispatcherKey(baseUrl: string, apiKey: string): string {
  return `${new URL(baseUrl).origin}\0${apiKey}`;
}

function getSharedDispatcher(baseUrl: string, apiKey: string): Promise<Dispatcher> {
  const key = dispatcherKey(baseUrl, apiKey);
  const existing = sharedDispatchers.get(key);
  if (existing) return existing;

  const dispatcher = (async () => {
    if (!undiciModule) throw new Error("The pooled control-plane transport requires Node.js");
    const { Agent } = await undiciModule;
    return new Agent({
      allowH2: true,
      connections: CONTROL_PLANE_CONNECTIONS,
      pipelining: CONTROL_PLANE_CONCURRENT_STREAMS,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    }).compose(multiplexHttp2Requests);
  })();

  sharedDispatchers.set(key, dispatcher);
  void dispatcher.catch(() => {
    // A transient module/initialization failure should not poison this pool
    // key permanently; let the next request retry initialization.
    if (sharedDispatchers.get(key) === dispatcher) sharedDispatchers.delete(key);
  });
  return dispatcher;
}

function createPooledFetch(baseUrl: string, apiKey: string): ((request: Request) => Promise<Response>) | undefined {
  if (!isNodeRuntime()) return undefined;

  return async (request: Request): Promise<Response> => {
    const dispatcher = await getSharedDispatcher(baseUrl, apiKey);
    return globalThis.fetch(request, { dispatcher } as RequestInit);
  };
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl ?? resolveBaseUrl(opts.region);
  const apiKey = `key-${opts.apiKey.replace(/^key-/, '')}`;
  return createClient<paths>({
    baseUrl,
    fetch: createPooledFetch(baseUrl, apiKey),
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
