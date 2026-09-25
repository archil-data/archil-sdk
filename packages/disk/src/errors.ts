import { parseXml } from "./s3xml.js";
import type { Image } from "./images.js";
import type { Sandbox } from "./sandbox.js";

/**
 * Base class for every error the SDK throws. Catch with `instanceof ArchilError`
 * to handle control-plane and S3 failures uniformly; `status` is the HTTP status
 * code and `code` a machine-readable error code when the server provided one.
 */
export class ArchilError extends Error {
  /** HTTP status code associated with the failure. */
  readonly status: number;
  /** Machine-readable error code (e.g. an S3 code like "NoSuchKey"), if known. */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ArchilError";
    this.status = status;
    this.code = code;
  }
}

/** Error from the control-plane REST API. */
export class ArchilApiError extends ArchilError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = "ArchilApiError";
  }
}

export class SandboxPauseError extends ArchilError {
  constructor(readonly latest: Sandbox) {
    super(
      `Sandbox entered ${latest.status} before it paused${latest.exitReason ? `: ${latest.exitReason}` : ""}`,
      409,
      "SANDBOX_PAUSE_FAILED",
    );
    this.name = "SandboxPauseError";
  }
}

export class ImageBuildError extends ArchilError {
  constructor(readonly latest: Image) {
    super(
      `Image build failed${latest.failureReason ? `: ${latest.failureReason}` : ""}`,
      400,
      "IMAGE_BUILD_FAILED",
    );
    this.name = "ImageBuildError";
  }
}

export class SandboxFileTransferError extends ArchilError {
  readonly operation: "upload" | "download";
  readonly path: string;

  constructor(operation: "upload" | "download", path: string, cause: Error) {
    super(
      `Sandbox file ${operation} failed for ${path}: ${cause.message}`,
      500,
      "SANDBOX_FILE_TRANSFER_FAILED",
    );
    this.name = "SandboxFileTransferError";
    this.operation = operation;
    this.path = path;
    this.cause = cause;
  }
}

/**
 * Error from the S3-compatible object API (getObject/putObject/deleteObject/
 * headObject/listObjects). The gateway returns an S3-style XML `<Error>` body;
 * this surfaces its parts as structured fields (`status`, `code`, `requestId`)
 * rather than a raw blob, while keeping the full body on `raw` for debugging.
 */
export class ArchilS3Error extends ArchilError {
  /** S3 request id, if the gateway returned one. */
  readonly requestId?: string;
  /** Raw response body (the XML document), for debugging. */
  readonly raw: string;

  constructor(opts: {
    operation: string;
    statusCode: number;
    statusText?: string;
    code?: string;
    message?: string;
    requestId?: string;
    raw: string;
  }) {
    const detail = opts.message ?? opts.statusText ?? "";
    const codePart = opts.code ? ` ${opts.code}` : "";
    super(
      `S3 ${opts.operation} failed: ${opts.statusCode}${codePart}${detail ? ` — ${detail}` : ""}`,
      opts.statusCode,
      opts.code,
    );
    this.name = "ArchilS3Error";
    this.requestId = opts.requestId;
    this.raw = opts.raw;
  }
}

function tagString(obj: Record<string, unknown>, tag: string): string | undefined {
  const value = obj[tag];
  return value === undefined || value === null ? undefined : String(value);
}

/** Build an ArchilS3Error from a failed S3 response, parsing the XML body. */
export function parseS3Error(
  operation: string,
  statusCode: number,
  statusText: string,
  body: string,
): ArchilS3Error {
  // Error bodies aren't always XML (e.g. a controlplane proxy 5xx); fall back to
  // no parsed fields rather than throwing while building an error.
  let err: Record<string, unknown> = {};
  try {
    err = (parseXml(body).Error ?? {}) as Record<string, unknown>;
  } catch {
    err = {};
  }
  return new ArchilS3Error({
    operation,
    statusCode,
    statusText,
    code: tagString(err, "Code"),
    message: tagString(err, "Message"),
    requestId: tagString(err, "RequestId"),
    raw: body,
  });
}
