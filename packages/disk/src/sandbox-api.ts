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

interface SandboxErrors {
  400: JsonResponse<never>;
  401: JsonResponse<never>;
  404: JsonResponse<never>;
  409: JsonResponse<never>;
  429: JsonResponse<never>;
  500: JsonResponse<never>;
}

type Params<Path, Query = never> = [Path] extends [never]
  ? { query?: Query; header?: never; path?: never; cookie?: never }
  : { query?: Query; header?: never; path: Path; cookie?: never };

type Get<T, Path = never, Query = never> = {
  parameters: Params<Path, Query>;
  requestBody?: never;
  responses: { 200: JsonResponse<T> } & SandboxErrors;
};

type Post<T, Path = never, Body = never> = {
  parameters: Params<Path>;
  responses: { 200: JsonResponse<T>; 202: JsonResponse<T> } & SandboxErrors;
} & ([Body] extends [never]
  ? { requestBody?: never }
  : { requestBody: { content: { "application/json": Body } } });

type Sid = { sid: string };
type SidEid = { sid: string; eid: string };

export interface SandboxApiPaths {
  "/api/sandboxes": {
    get: Get<{ sandboxes?: SandboxWire[] }, never, { filesystem?: string }>;
    post: Post<SandboxWire, never, CreateSandboxWire>;
  };
  "/api/sandboxes/{sid}": { get: Get<SandboxWire, Sid> };
  "/api/sandboxes/{sid}/start": { post: Post<SandboxWire, Sid> };
  "/api/sandboxes/{sid}/stop": { post: Post<SandboxWire, Sid> };
  "/api/sandboxes/{sid}/execs": {
    get: Get<{ execs?: SandboxExecWire[] }, Sid>;
    post: Post<SandboxExecWire, Sid, SandboxExecRequestWire>;
  };
  "/api/sandboxes/{sid}/execs/{eid}": { get: Get<SandboxExecWire, SidEid> };
  "/api/sandboxes/{sid}/execs/{eid}/cancel": { post: Post<SandboxExecWire, SidEid> };
}
