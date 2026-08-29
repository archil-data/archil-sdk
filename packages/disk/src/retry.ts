export type RetryMode = "none" | "connect" | "transient";

export const MAX_RETRIES = 3;

const RETRY_BASE_MS = 100;
const RETRY_CAP_MS = 2_000;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const CONNECT_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

export function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

export function retrySleep(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
}

function isConnectionEstablishmentError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (typeof current !== "object") continue;
    const value = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    const code = typeof value.code === "string" ? value.code : "";
    if (
      CONNECT_ERROR_CODES.has(code) ||
      code.startsWith("ERR_SSL_") ||
      code.startsWith("ERR_TLS_")
    ) {
      return true;
    }
    if (
      typeof value.message === "string" &&
      value.message.includes("before secure TLS connection was established")
    ) {
      return true;
    }
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return false;
}

export async function retryApiRequest<T extends { response: Response }>(
  request: () => Promise<T>,
  mode: RetryMode,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await request();
      if (
        mode !== "transient" ||
        !isTransientStatus(result.response.status) ||
        attempt >= MAX_RETRIES
      ) {
        return result;
      }
    } catch (error) {
      const retry =
        mode === "transient" ||
        (mode === "connect" && isConnectionEstablishmentError(error));
      if (!retry || attempt >= MAX_RETRIES) throw error;
    }
    await retrySleep(attempt);
  }
}
