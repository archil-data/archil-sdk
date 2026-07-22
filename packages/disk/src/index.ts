import { Archil, type ArchilOptions, type ExecMount, type ExecOptions } from "./archil.js";
import type { CreateDiskRequest, ApiTokenResponse, CreateApiTokenRequest, ExecDiskResult } from "./types.js";
import type { CreateSandboxOptions, ListSandboxesOptions, StartSandboxOptions } from "./sandboxes.js";
import type { Sandbox } from "./sandbox.js";
import type { CreateDiskResult, ListDisksOptions } from "./disks.js";
import type { Disk } from "./disk.js";
import type { ListTokensOptions } from "./tokens.js";
import { Workspace } from "./workspace.js";

export { Archil } from "./archil.js";
export type { ArchilOptions, ExecMount, ExecMountSpec, ExecOptions } from "./archil.js";

export { Disks } from "./disks.js";
export type { ListDisksOptions, CreateDiskResult, DiskListPage } from "./disks.js";

export { Tokens } from "./tokens.js";
export type { ListTokensOptions } from "./tokens.js";

export { Disk, DiskMultipart, effectiveUploadPartSize } from "./disk.js";
export type {
  MountOptions,
  ExecResult,
  GrepOptions,
  GrepResult,
  GrepMatch,
  GrepStoppedReason,
  ListObjectsOptions,
  ListObjectsResult,
  S3Object,
  PutObjectResult,
  ObjectMetadata,
  ShareUrlOptions,
  ShareUrlResult,
  PutObjectOptions,
  AppendObjectOptions,
  PosixCreateAttrs,
  UploadPart,
  MultipartUpload,
  CompletedMultipartUpload,
  PartInfo,
  ListPartsOptions,
  PartListing,
  MultipartUploadSummary,
  ListMultipartUploadsOptions,
  MultipartUploadListing,
  DeleteObjectsOptions,
  DeleteObjectsError,
  DeleteObjectsResult,
} from "./disk.js";

export { ArchilError, ArchilApiError, ArchilS3Error, ArchilTimeoutError } from "./errors.js";

export { Sandboxes } from "./sandboxes.js";
export type {
  CreateSandboxOptions,
  ListSandboxesOptions,
  SandboxMount,
  StartSandboxOptions,
} from "./sandboxes.js";

export { Sandbox } from "./sandbox.js";
export type {
  SandboxExecResult,
  SandboxExecStatus,
  SandboxInfo,
  SandboxPort,
  SandboxResources,
  SandboxRunOptions,
  SandboxStatus,
  SandboxWaitOptions,
} from "./sandbox.js";

export { VERSION, USER_AGENT } from "./version.js";

export { Workspace } from "./workspace.js";
export type { FileSystem } from "./filesystem.js";

export type {
  DiskResponse,
  DiskStatus,
  MountResponse,
  MountConfigResponse,
  DiskMetrics,
  ConnectedClient,
  Delegation,
  AuthorizedUser,
  CreateDiskRequest,
  MountConfig,
  S3Mount,
  GCSMount,
  R2Mount,
  S3CompatibleMount,
  AzureBlobMount,
  DiskUser,
  TokenUser,
  AwsStsUser,
  CreateApiTokenRequest,
  ApiTokenResponse,
  ExecRequest,
} from "./types.js";

// Module-level Archil instance backing the top-level convenience functions.
// Defaults to env-based config (ARCHIL_API_KEY, ARCHIL_REGION); call configure()
// to pass options explicitly or to swap credentials mid-process.

let _options: ArchilOptions | undefined;
let _instance: Archil | undefined;

export function configure(options: ArchilOptions): void {
  _options = options;
  _instance = undefined;
}

function archil(): Archil {
  if (!_instance) {
    _instance = new Archil(_options);
  }
  return _instance;
}

export function createDisk(req: CreateDiskRequest): Promise<CreateDiskResult> {
  return archil().disks.create(req);
}

export function listDisks(opts?: ListDisksOptions): Promise<Disk[]> {
  return archil().disks.list(opts);
}

export function getDisk(id: string): Promise<Disk> {
  return archil().disks.get(id);
}

export function listApiKeys(opts?: ListTokensOptions): Promise<ApiTokenResponse[]> {
  return archil().tokens.list(opts);
}

export function createApiKey(
  req: CreateApiTokenRequest,
): Promise<ApiTokenResponse & { token?: string }> {
  return archil().tokens.create(req);
}

export function deleteApiKey(id: string): Promise<void> {
  return archil().tokens.delete(id);
}

/**
 * Run a command in a container with multiple disks mounted simultaneously,
 * each at its own relative path under `/mnt/archil`. Blocks until the
 * command completes and returns its stdout, stderr, exit code, and timing.
 */
export function exec(opts: ExecOptions): Promise<ExecDiskResult> {
  return archil().exec(opts);
}

/**
 * Build an agent filesystem toolset spanning several disks, using the
 * module-level client. See {@link Archil.workspace}.
 */
export function workspace(mounts: Record<string, ExecMount>): Workspace {
  return archil().workspace(mounts);
}

export function createSandbox(opts?: CreateSandboxOptions): Promise<Sandbox> {
  return archil().sandbox.create(opts);
}

export function getSandbox(id: string): Promise<Sandbox> {
  return archil().sandbox.get(id);
}

export function listSandboxes(opts?: ListSandboxesOptions): Promise<Sandbox[]> {
  return archil().sandbox.list(opts);
}

/** Start (or resume) a stopped sandbox by id, using the module-level client. */
export function startSandbox(opts: StartSandboxOptions): Promise<Sandbox> {
  return archil().sandbox.start(opts);
}
