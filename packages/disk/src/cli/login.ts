// `archil login`: browser sign-in without copying API keys around.
//
// The CLI listens on 127.0.0.1 and opens the console at /cli/login with that
// port and a random `state`. After the user clicks Authorize, the console
// creates an API key for their account and submits it, with the same `state`,
// as a form POST to http://127.0.0.1:<port>/callback. The CLI accepts exactly
// one callback whose state matches, then saves the key as a profile.
//
// The callback's `apiKey`, `keyId`, `region` and `baseUrl` fields describe the
// key for the account's default region; that is all 0.1.0 CLIs read. Keys only
// work in the region that created them, so the console may also send `keys`, a
// JSON list of `{region, apiKey, keyId?, baseUrl?}` covering every region, and
// `accountId`, a stable id that finds this account's profile on the next login.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";

export const DEFAULT_CONSOLE_URL = "https://console.archil.com";
const MAX_CALLBACK_BYTES = 64 * 1024;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export interface RegionKey {
  region: string;
  apiKey: string;
  keyId?: string;
  baseUrl?: string;
}

/** The default region's key, plus `keys`: every region's key, the default's first. */
export interface LoginGrant extends RegionKey {
  account?: string;
  accountId?: string;
  keys: RegionKey[];
}

export class LoginDeniedError extends Error {}

export interface LoginSession {
  /** Console URL to open in the browser. */
  url: string;
  /** Resolves with the grant, or rejects when denied, timed out, or cancelled. */
  grant: Promise<LoginGrant>;
  close(): void;
}

export function consoleUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ARCHIL_CONSOLE_URL ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
}

/** Starts the loopback listener and returns the URL the user should open. */
export async function startLoginSession(options: { console?: string; timeoutMs?: number; machine?: string; region?: string } = {}): Promise<LoginSession> {
  const base = options.console ?? consoleUrl();
  const state = randomBytes(32).toString("hex");
  let settle!: { resolve: (grant: LoginGrant) => void; reject: (error: Error) => void };
  const grant = new Promise<LoginGrant>((resolve, reject) => { settle = { resolve, reject }; });
  // Callers may await the grant only later; don't let an early rejection count as unhandled.
  grant.catch(() => {});
  let finished = false;
  const finish = (outcome: { grant?: LoginGrant; error?: Error }) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // Let the browser receive its page before the listener goes away. Browsers
    // hold idle keep-alive sockets open, which would keep this process alive.
    setTimeout(() => {
      server.close();
      server.closeAllConnections();
    }, 100).unref();
    if (outcome.grant) settle.resolve(outcome.grant);
    else settle.reject(outcome.error!);
  };

  const server = createServer((request, response) => {
    handleCallback(request, response, state, base).then(
      (outcome) => { if (outcome) finish(outcome); },
      () => respond(response, 400, page("Something went wrong", "The CLI couldn't read the sign-in response. Run archil login again.")),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const timer = setTimeout(() => finish({ error: new Error("Timed out waiting for the browser; run archil login again") }), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timer.unref();

  const port = (server.address() as { port: number }).port;
  const params = new URLSearchParams({ port: String(port), state, hostname: options.machine ?? hostname() });
  if (options.region) params.set("region", options.region);
  return {
    url: `${base}/cli/login?${params}`,
    grant,
    close: () => finish({ error: new Error("Login cancelled") }),
  };
}

async function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  state: string,
  consoleBase: string,
): Promise<{ grant?: LoginGrant; error?: Error } | undefined> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "POST" || url.pathname !== "/callback") {
    respond(response, 404, page("Not found", "This address only receives Archil CLI sign-ins."));
    return undefined;
  }
  // A form POST from the console carries its origin, except that browsers send
  // `Origin: null` when an HTTPS page posts to plain HTTP (the default
  // strict-origin-when-cross-origin policy), which is exactly the console
  // reaching this listener. The single-use state below is what authenticates
  // the callback; this only turns away other sites that name themselves.
  const origin = request.headers.origin;
  if (origin && origin !== "null" && origin !== new URL(consoleBase).origin) {
    respond(response, 403, page("Not allowed", "This sign-in didn't come from the Archil console."));
    return undefined;
  }
  const fields = new URLSearchParams(await readBody(request));
  if (!sameSecret(fields.get("state") ?? "", state)) {
    respond(response, 400, page("Sign-in link expired", "This page doesn't match the sign-in your terminal started. Run archil login again."));
    return undefined;
  }
  if (fields.get("error")) {
    respond(response, 200, page("Sign-in cancelled", "No key was created. You can close this tab."));
    return { error: new LoginDeniedError("Sign-in was cancelled in the browser") };
  }
  const apiKey = fields.get("apiKey");
  const region = fields.get("region");
  if (!apiKey || !region) {
    respond(response, 400, page("Something went wrong", "The console didn't send a key. Run archil login again."));
    return { error: new Error("The console didn't send an API key") };
  }
  const defaultKey: RegionKey = {
    region,
    apiKey,
    keyId: fields.get("keyId") || undefined,
    baseUrl: fields.get("baseUrl") || undefined,
  };
  let otherKeys: RegionKey[];
  try {
    otherKeys = parseRegionKeys(fields.get("keys")).filter((key) => key.region !== region);
  } catch (error) {
    respond(response, 400, page("Something went wrong", "The console sent keys the CLI couldn't read. Run archil login again."));
    return { error: new Error(`The console sent malformed keys: ${(error as Error).message}`) };
  }
  const account = fields.get("account") || undefined;
  respond(response, 200, page(
    "You're signed in",
    `${account ? `The CLI is now signed in to ${account}. ` : ""}Return to your terminal; you can close this tab.`,
    true,
  ));
  return {
    grant: {
      ...defaultKey,
      account,
      accountId: fields.get("accountId") || undefined,
      keys: [defaultKey, ...otherKeys],
    },
  };
}

/** Parses the `keys` field; a missing field means the scalar fields are the only key. */
export function parseRegionKeys(value: string | null): RegionKey[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("keys must be a JSON array");
  const seen = new Set<string>();
  return parsed.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`keys[${index}] must be an object`);
    const { region, apiKey, keyId, baseUrl } = entry as Record<string, unknown>;
    if (typeof region !== "string" || !region) throw new Error(`keys[${index}] has no region`);
    if (typeof apiKey !== "string" || !apiKey) throw new Error(`keys[${index}] has no apiKey`);
    if (keyId !== undefined && typeof keyId !== "string") throw new Error(`keys[${index}].keyId must be a string`);
    if (baseUrl !== undefined && typeof baseUrl !== "string") throw new Error(`keys[${index}].baseUrl must be a string`);
    if (seen.has(region)) throw new Error(`keys lists ${region} twice`);
    seen.add(region);
    return { region, apiKey, keyId: keyId || undefined, baseUrl: baseUrl || undefined };
  });
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CALLBACK_BYTES) {
        reject(new Error("callback too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respond(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    Connection: "close",
  });
  response.end(html);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

const LOGO = `<svg viewBox="0 0 64 64" width="28" height="28" fill="none" aria-hidden="true"><rect x="1.82" y="1.82" width="60.36" height="60.36" stroke="currentColor" stroke-width="2"/><path transform="translate(-115.998 -166.784)" d="M172.376 222.438L169.116 222.447V207.734C169.116 206.191 167.865 204.939 166.321 204.938H156.427C155.042 204.939 153.762 205.677 153.067 206.876L144.003 222.525L123.625 222.59L150.84 175.562L172.376 175.41V222.438ZM168.961 184.194C168.961 182.71 167.017 182.155 166.233 183.415L156.512 199.038C155.836 200.124 156.617 201.53 157.896 201.53H166.088C167.675 201.53 168.961 200.244 168.961 198.657V184.194Z" fill="currentColor"/></svg>`;

function page(title: string, message: string, success = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Archil CLI</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #111; --muted: #666; --card: #fff; --border: #e5e5e5; --ok: #16a34a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #ededed; --muted: #a1a1a1; --card: #141414; --border: #262626; --ok: #22c55e; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  header { padding: 32px 32px 16px; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; letter-spacing: -0.01em; }
  main { flex: 1; display: flex; justify-content: center; padding: 48px 20px 96px; }
  section { width: min(560px, 100%); }
  .mark { width: 40px; height: 40px; border-radius: 999px; display: grid; place-items: center; margin-bottom: 24px; background: ${success ? "color-mix(in srgb, var(--ok) 14%, transparent)" : "color-mix(in srgb, var(--muted) 14%, transparent)"}; color: ${success ? "var(--ok)" : "var(--muted)"}; font-size: 20px; }
  h1 { margin: 0 0 6px; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
  p { margin: 0; color: var(--muted); font-size: 13px; }
</style></head>
<body><header>${LOGO}<span>ARCHIL</span></header>
<main><section><div class="mark">${success ? "✓" : "!"}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section></main></body></html>`;
}
