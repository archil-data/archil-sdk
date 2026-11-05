import type { paths } from "@archildata/api-types";

// A minimal typed fetch client over the control plane's OpenAPI `paths`: each
// method takes a templated path plus its `params` (path/query/header) and JSON
// `body`, and resolves to `{ data }` on success or `{ error }` (the parsed
// JSON, or raw text) otherwise, alongside the `response`.

type HttpMethod = "get" | "put" | "post" | "delete" | "patch";

type PathsWith<M extends HttpMethod> = {
  [P in keyof paths]: paths[P] extends { [K in M]: unknown } ? P : never;
}[keyof paths];

type Operation<P extends keyof paths, M extends HttpMethod> = paths[P] extends { [K in M]: infer O } ? O : never;

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];

type ParamsInit<O> = O extends { parameters: infer P }
  ? [RequiredKeys<P>] extends [never] ? { params?: P } : { params: P }
  : { params?: never };

type JsonBodyInit<O> = O extends { requestBody: { content: { "application/json": infer B } } }
  ? { body: B }
  : O extends { requestBody?: { content: { "application/json": infer B } } }
    ? { body?: B }
    : { body?: never };

type RequestOptions<O> = ParamsInit<O> & JsonBodyInit<O>;

type InitArgs<O> = [RequiredKeys<RequestOptions<O>>] extends [never]
  ? [init?: RequestOptions<O>]
  : [init: RequestOptions<O>];

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 206;

type ResponseData<O> = O extends { responses: infer R }
  ? R[Extract<keyof R, SuccessStatus>] extends infer S
    ? S extends { content: { "application/json": infer J } } ? J : undefined
    : never
  : never;

export type FetchResult<O> =
  | { data: ResponseData<O>; error?: undefined; response: Response }
  | { data?: undefined; error: unknown; response: Response };

type MethodFn<M extends HttpMethod> = <P extends PathsWith<M>>(
  path: P,
  ...init: InitArgs<Operation<P, M>>
) => Promise<FetchResult<Operation<P, M>>>;

export interface ApiClient {
  GET: MethodFn<"get">;
  PUT: MethodFn<"put">;
  POST: MethodFn<"post">;
  DELETE: MethodFn<"delete">;
  PATCH: MethodFn<"patch">;
  /**
   * Send an untyped request through the client's transport and default
   * headers, returning the raw response (used for the S3 gateway).
   */
  raw(method: string, url: string, init?: { headers?: Record<string, string>; body?: string | Uint8Array | ArrayBuffer }): Promise<Response>;
}

export interface ApiClientConfig {
  baseUrl: string;
  headers: Record<string, string>;
  /** Transport for every request; defaults to the global fetch. */
  fetch?: (request: Request) => Promise<Response>;
}

type QueryValue = string | number | boolean | null | undefined;

interface UntypedInit {
  params?: {
    path?: Record<string, string | number>;
    query?: Record<string, QueryValue | QueryValue[]>;
    header?: Record<string, string | undefined>;
  };
  body?: unknown;
}

function buildPath(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter '${name}' for ${template}`);
    return encodeURIComponent(String(value));
  });
}

/** Serialize a query object; undefined/null values are omitted and arrays repeat the key. */
export function buildQuery(query: Record<string, QueryValue | QueryValue[]> = {}): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(item))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function createClient(config: ApiClientConfig): ApiClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const send = (request: Request) => (config.fetch ?? globalThis.fetch)(request);

  const headersFor = (extra: Record<string, string | undefined> = {}): Headers => {
    const headers = new Headers(config.headers);
    for (const [name, value] of Object.entries(extra)) {
      if (value !== undefined) headers.set(name, value);
    }
    return headers;
  };

  const call = async (method: string, path: string, init: UntypedInit = {}) => {
    const url = baseUrl + buildPath(path, init.params?.path) + buildQuery(init.params?.query);
    const headers = headersFor(init.params?.header);
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
    const response = await send(new Request(url, { method, headers, body }));

    if (response.status === 204 || response.headers.get("Content-Length") === "0") {
      await response.body?.cancel().catch(() => {});
      return response.ok ? { data: undefined, response } : { error: undefined, response };
    }
    if (response.ok) return { data: await response.json() as unknown, response };

    const text = await response.text();
    let error: unknown = text;
    try {
      error = JSON.parse(text);
    } catch {
      // Not JSON: keep the raw text.
    }
    return { error, response };
  };

  const method = (name: string) => ((path: string, init?: UntypedInit) => call(name, path, init)) as never;

  return {
    GET: method("GET"),
    PUT: method("PUT"),
    POST: method("POST"),
    DELETE: method("DELETE"),
    PATCH: method("PATCH"),
    raw: (methodName, url, init = {}) =>
      send(new Request(url, {
        method: methodName,
        headers: headersFor(init.headers),
        body: init.body as BodyInit | undefined,
      })),
  };
}
