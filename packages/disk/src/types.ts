import type { components } from "@archildata/api-types";

export type DiskResponse = components["schemas"]["DiskResponse"];
export type MountResponse = components["schemas"]["MountResponse"];
export type MountConfigResponse = components["schemas"]["MountConfigResponse"];
export type DiskMetrics = components["schemas"]["DiskMetrics"];
export type ConnectedClient = components["schemas"]["ConnectedClient"];
export type AuthorizedUser = components["schemas"]["AuthorizedUser"];

export type CreateDiskRequest = components["schemas"]["CreateDiskRequest"];
export type MountConfig = components["schemas"]["MountConfig"];
export type S3Mount = components["schemas"]["S3Mount"];
export type GCSMount = components["schemas"]["GCSMount"];
export type R2Mount = components["schemas"]["R2Mount"];
export type S3CompatibleMount = components["schemas"]["S3CompatibleMount"];
export type AzureBlobMount = components["schemas"]["AzureBlobMount"];

export type Delegation = components["schemas"]["DelegationEntry"];

export type DiskUser = components["schemas"]["DiskUser"];
export type TokenUser = components["schemas"]["TokenUser"];
export type AwsStsUser = components["schemas"]["AwsStsUser"];

export type CreateApiTokenRequest = components["schemas"]["CreateApiTokenRequest"];
export type ApiTokenResponse = components["schemas"]["ApiTokenResponse"];

export type ExecDiskRequest = components["schemas"]["ExecDiskRequest"];
export type ExecDiskResult = components["schemas"]["ExecDiskResult"];
export type ExecTiming = components["schemas"]["ExecTiming"];
export type ExecRequest = components["schemas"]["ExecRequest"];

export type GrepDiskRequest = components["schemas"]["GrepDiskRequest"];
export type GrepDiskResult = components["schemas"]["GrepDiskResult"];
export type GrepMatch = components["schemas"]["GrepMatch"];
export type GrepStoppedReason = components["schemas"]["GrepStoppedReason"];

export type DiskStatus = DiskResponse["status"];
