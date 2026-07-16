import { parseXml } from "./s3xml.js";

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

/**
 * Thrown when a client-side wait exceeds its deadline: waiting for a sandbox
 * to reach a target state, or polling a sandbox exec past its timeout. The
 * operation may still complete server-side; re-fetch to observe its state.
 * `status` is always 408 — no HTTP response is involved.
 */
export class ArchilTimeoutError extends ArchilError {
  constructor(message: string) {
    super(message, 408);
    this.name = "ArchilTimeoutError";
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
