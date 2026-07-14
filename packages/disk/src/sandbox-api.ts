// Hand-written wire types for the control plane's /api/sandboxes surface,
// in the same shape openapi-typescript generates. Only start/stop are specced
// in the control plane's openapi.yaml today; once the full surface lands in
// @archildata/api-types, these can be replaced with the generated types.

export type SandboxStatusWire =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "exited"
  | "failed";

export type SandboxExecStatusWire =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface SandboxWire {
  sandbox_id: string;
  status: SandboxStatusWire;
  port_mappings?: SandboxPortMappingWire[];
  vcpu_count: number;
  mem_size_mib: number;
  max_ttl_seconds: number;
  max_concurrent_execs: number;
  created_at: string;
  running_at?: string;
  finished_at?: string;
  last_active_at: string;
  expires_at?: string;
  exit_reason?: string;
}

export interface SandboxPortMappingWire {
  container_port: number;
  protocol: "tcp" | "udp";
}

export interface SandboxMountWire {
  disk_id: string;
  relative_path?: string;
  subdirectory?: string;
  read_only?: boolean;
  shared?: boolean;
  region?: string;
}

export interface CreateSandboxWire {
  vcpu_count?: number;
  mem_size_mib?: number;
  kernel?: string;
  base_image?: string;
  archil_mounts?: SandboxMountWire[];
  port_mappings?: SandboxPortMappingWire[];
  env?: Record<string, string>;
  max_ttl_seconds?: number;
  max_concurrent_execs?: number;
}

export interface SandboxExecRequestWire {
  command: string;
  command_tty?: boolean;
  env?: Record<string, string>;
  timeout_seconds?: number;
}

export interface SandboxExecWire {
  sandbox_id: string;
  exec_id: string;
  command: string;
  status: SandboxExecStatusWire;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  exit_reason?: string;
  execute_time_ms?: number;
  started_at: string;
  finished_at?: string;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface JsonResponse<T> {
  headers: { [name: string]: unknown };
  content: { "application/json": Envelope<T> };
}

interface ErrorResponse {
  headers: { [name: string]: unknown };
  content: { "application/json": { success: boolean; error?: string } };
}

type NoParams = { query?: never; header?: never; path?: never; cookie?: never };

interface SandboxErrors {
  400: ErrorResponse;
  401: ErrorResponse;
  404: ErrorResponse;
  409: ErrorResponse;
  429: ErrorResponse;
  500: ErrorResponse;
}

export interface SandboxApiPaths {
  "/api/sandboxes": {
    parameters: NoParams;
    get: {
      parameters: { query?: { filesystem?: string }; header?: never; path?: never; cookie?: never };
      requestBody?: never;
      responses: { 200: JsonResponse<{ sandboxes?: SandboxWire[] }> } & SandboxErrors;
    };
    post: {
      parameters: NoParams;
      requestBody: { content: { "application/json": CreateSandboxWire } };
      responses: { 202: JsonResponse<SandboxWire> } & SandboxErrors;
    };
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sandboxes/{sid}": {
    parameters: NoParams;
    get: {
      parameters: { query?: never; header?: never; path: { sid: string }; cookie?: never };
      requestBody?: never;
      responses: { 200: JsonResponse<SandboxWire> } & SandboxErrors;
    };
    post?: never;
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sandboxes/{sid}/start": {
    parameters: NoParams;
    get?: never;
    post: {
      parameters: { query?: never; header?: never; path: { sid: string }; cookie?: never };
      requestBody?: never;
      responses: { 200: JsonResponse<SandboxWire>; 202: JsonResponse<SandboxWire> } & SandboxErrors;
    };
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sandboxes/{sid}/stop": {
    parameters: NoParams;
    get?: never;
    post: {
      parameters: { query?: never; header?: never; path: { sid: string }; cookie?: never };
      requestBody?: never;
      responses: { 200: JsonResponse<SandboxWire>; 202: JsonResponse<SandboxWire> } & SandboxErrors;
    };
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sandboxes/{sid}/execs": {
    parameters: NoParams;
    get: {
      parameters: { query?: never; header?: never; path: { sid: string }; cookie?: never };
      requestBody?: never;
      responses: { 200: JsonResponse<{ execs?: SandboxExecWire[] }> } & SandboxErrors;
    };
    post: {
      parameters: { query?: never; header?: never; path: { sid: string }; cookie?: never };
      requestBody: { content: { "application/json": SandboxExecRequestWire } };
      responses: { 202: JsonResponse<SandboxExecWire> } & SandboxErrors;
    };
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sandboxes/{sid}/execs/{eid}": {
    parameters: NoParams;
    get: {
      parameters: { query?: never; header?: never; path: { sid: string; eid: string }; cookie?: never };
      requestBody?: never;
      responses: { 200: JsonResponse<SandboxExecWire> } & SandboxErrors;
    };
    post?: never;
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/sandboxes/{sid}/execs/{eid}/cancel": {
    parameters: NoParams;
    get?: never;
    post: {
      parameters: { query?: never; header?: never; path: { sid: string; eid: string }; cookie?: never };
      requestBody?: never;
      responses: { 200: JsonResponse<SandboxExecWire> } & SandboxErrors;
    };
    put?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
