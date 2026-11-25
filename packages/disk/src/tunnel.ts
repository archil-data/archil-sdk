// `disk/tunnel` (Node.js only): serve a sandbox's private port on localhost.
//
// Each local connection is relayed over TLS to the port's
// `<port>-<route>.<zone>` hostname with an Archil port token added to its first
// request. Archil authenticates only that first request and then relays the
// connection unchanged, so this carries HTTP and WebSockets but not protocols
// that don't start with an HTTP request.

import { createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { Sandbox } from "./sandbox.js";
import { DESKTOP_PORT, desktopViewerPath } from "./sandbox-desktop.js";

const PORT_TOKEN_HEADER = "X-Archil-Token";
const MAX_REQUEST_HEAD_BYTES = 16 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");
const UPGRADE = /^upgrade:\s*websocket\s*$/im;

export interface PortTunnelActivity {
  /** Local connections currently open. */
  connections: number;
  /** Of those, connections upgraded to WebSockets (a noVNC viewer holds one). */
  websockets: number;
}

export interface PortTunnel {
  /** Local port the tunnel listens on. */
  port: number;
  /** Use `token` for connections opened from now on (existing ones stay authenticated). */
  setPortToken(token: string): void;
  close(): Promise<void>;
}

export interface PortTunnelOptions {
  /** `<port>-<route>.<zone>` hostname returned with the port token. */
  hostname: string;
  portToken: string;
  /** Local port to listen on; 0 picks a free one. */
  localPort: number;
  onActivity?: (activity: PortTunnelActivity) => void;
  /** Opens the upstream connection; tests replace the TLS dial. */
  connectUpstream?: (hostname: string) => Duplex;
}

export async function openPortTunnel(options: PortTunnelOptions): Promise<PortTunnel> {
  const connectUpstream = options.connectUpstream
    ?? ((hostname: string) => tlsConnect({ host: hostname, port: 443, servername: hostname }));
  let portToken = options.portToken;
  const sockets = new Set<Socket>();
  const websockets = new Set<Socket>();
  const report = () => options.onActivity?.({ connections: sockets.size, websockets: websockets.size });
  const server = createServer((client) => {
    sockets.add(client);
    report();
    client.once("close", () => {
      sockets.delete(client);
      websockets.delete(client);
      report();
    });
    relay(client, () => connectUpstream(options.hostname), portToken, () => (server.address() as { port: number }).port, (head) => {
      if (UPGRADE.test(head.toString("latin1"))) {
        websockets.add(client);
        report();
      }
    }).catch(() => client.destroy());
  });
  await listen(server, options.localPort);
  return {
    port: (server.address() as { port: number }).port,
    setPortToken: (token) => { portToken = token; },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function relay(
  client: Socket,
  connectUpstream: () => Duplex,
  portToken: string,
  localPort: () => number,
  onHead: (head: Buffer) => void,
): Promise<void> {
  const head = await readRequestHead(client);
  // A web page can point its own hostname at 127.0.0.1 (DNS rebinding) and
  // reach this listener; only relay requests addressed to the tunnel itself,
  // so the access token is never added to someone else's request.
  if (!isLocalHost(requestHost(head), localPort())) {
    const body = "This tunnel only serves requests to localhost.\n";
    client.end(`HTTP/1.1 421 Misdirected Request\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    return;
  }
  onHead(head);
  const upstream = connectUpstream();
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.write(addRequestHeader(head, `${PORT_TOKEN_HEADER}: ${portToken}`));
  client.pipe(upstream).pipe(client);
}

function requestHost(head: Buffer): string | undefined {
  const match = /^host:[ \t]*([^\r\n]*?)[ \t]*$/im.exec(head.toString("latin1"));
  return match?.[1]?.toLowerCase();
}

/** Whether `host` (a Host header) names this machine's loopback on `port`. */
export function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const names = ["127.0.0.1", "localhost", "[::1]"];
  return names.some((name) => host === `${name}:${port}` || (port === 80 && host === name));
}

/** Inserts `header` after the request line of the buffered request head. */
export function addRequestHeader(head: Buffer, header: string): Buffer {
  const requestLineEnd = head.indexOf("\r\n") + 2;
  return Buffer.concat([head.subarray(0, requestLineEnd), Buffer.from(`${header}\r\n`), head.subarray(requestLineEnd)]);
}

/** Reads through the end of the first request's headers; returns everything read. */
function readRequestHead(client: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      client.off("data", onData);
      client.off("end", onEnd);
      client.off("error", onEnd);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.includes(HEAD_END)) {
        cleanup();
        client.pause();
        resolve(buffered);
      } else if (buffered.length > MAX_REQUEST_HEAD_BYTES) {
        cleanup();
        reject(new Error("request head too large"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("connection closed before the request head"));
    };
    client.on("data", onData);
    client.on("end", onEnd);
    client.on("error", onEnd);
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const TOKEN_TTL = "12h";
/** Renew two hours before the 12-hour TTL, leaving room for retries. */
const TOKEN_RENEW_AFTER_MS = 10 * 60 * 60 * 1000;
const TOKEN_RENEW_CHECK_MS = 30 * 1000;
const KEEPALIVE_RETRY_MS = 5 * 1000;
/** The keepalive ends on its own after this, in case the process dies without cleaning up. */
const KEEPALIVE_MAX_SECONDS = 36 * 60 * 60;

export interface ForwardPortOptions {
  /** Local port. Defaults to the sandbox port, or any free port if that one is taken or privileged. */
  localPort?: number;
  /**
   * Hold a process connection for the forward's lifetime so the sandbox
   * doesn't idle-pause: its idle timer only runs while it has no process
   * connections, and tunnel traffic isn't one. Defaults to true.
   */
  keepAwake?: boolean;
  /** Called whenever local connections open or close. */
  onActivity?: (activity: PortTunnelActivity) => void;
  /** Called for problems that don't stop the forward (keepalive or token renewal failures). */
  onWarning?: (message: string) => void;
  /** @internal Replaces the local listener; for tests. */
  openTunnel?: (options: PortTunnelOptions) => Promise<PortTunnel>;
}

export interface ForwardedPort {
  /** Port listening on 127.0.0.1. */
  localPort: number;
  /**
   * `http://127.0.0.1:<localPort>`. Not `localhost`, which can resolve to ::1,
   * where another local server may hold the same port.
   */
  url: string;
  /**
   * Stops listening, ends the keepalive, and revokes the access token. The
   * sandbox's other process connections are left alone.
   */
  close(): Promise<void>;
}

/**
 * Serves `port` of a running sandbox on localhost without making it public,
 * until {@link ForwardedPort.close}. The access token is renewed before it
 * expires.
 */
export async function forwardPort(sandbox: Sandbox, port: number, options: ForwardPortOptions = {}): Promise<ForwardedPort> {
  const warn = options.onWarning ?? (() => {});
  const open = options.openTunnel ?? openPortTunnel;
  let access = await sandbox.createPortToken(port, { ttl: TOKEN_TTL });
  const tunnelOptions = (localPort: number): PortTunnelOptions => ({
    hostname: access.hostname,
    portToken: access.token,
    localPort,
    onActivity: options.onActivity,
  });
  let tunnel: PortTunnel;
  try {
    tunnel = await open(tunnelOptions(options.localPort ?? port)).catch((error: NodeJS.ErrnoException) => {
      // Taken, or privileged (ports below 1024 on Linux): use any free port instead.
      if (options.localPort !== undefined || (error.code !== "EADDRINUSE" && error.code !== "EACCES")) throw error;
      return open(tunnelOptions(0));
    });
  } catch (error) {
    await sandbox.deletePortToken(access.id).catch(() => {});
    throw error;
  }

  let closing = false;
  let wakeSleeper: (() => void) | undefined;
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    wakeSleeper = () => { clearTimeout(timer); resolve(); };
  });

  // Hold a do-nothing process so the sandbox's idle timer stays off, and start
  // another whenever it ends or its connection drops.
  let keepalive: Awaited<ReturnType<Sandbox["run"]>> | undefined;
  const keepAwake = options.keepAwake === false ? undefined : (async () => {
    let failures = 0;
    while (!closing) {
      try {
        const started = await sandbox.run("exec tail -f /dev/null", { collectOutput: false, timeoutSeconds: KEEPALIVE_MAX_SECONDS });
        if (closing) {
          // close() ran while this was starting and couldn't see it; stop it here.
          await started.kill().catch(() => {});
          await started.disconnect().catch(() => {});
          break;
        }
        keepalive = started;
        if (failures > 0) warn("The sandbox is being kept awake again.");
        failures = 0;
        await keepalive.wait();
      } catch {
        // Ended or disconnected; handled below.
      }
      if (closing) break;
      if (failures++ === 0) warn("Lost the connection keeping the sandbox awake; retrying. It may pause after its idle timeout until then.");
      await pause(Math.min(KEEPALIVE_RETRY_MS * failures, 60_000));
    }
  })();

  // Renew on a wall-clock schedule, checked often, so a failed renewal is
  // retried within minutes and a laptop waking from sleep renews right away.
  let renewAt = Date.now() + TOKEN_RENEW_AFTER_MS;
  let renewFailures = 0;
  let renewing: Promise<void> | undefined;
  const renew = () => {
    renewing = (async () => {
      const next = await sandbox.createPortToken(port, { ttl: TOKEN_TTL });
      if (closing) {
        // Closed while this token was being made; nothing will use it.
        await sandbox.deletePortToken(next.id).catch(() => {});
        return;
      }
      tunnel.setPortToken(next.token);
      const previous = access;
      access = next;
      renewAt = Date.now() + TOKEN_RENEW_AFTER_MS;
      if (renewFailures > 0) warn("Renewed the tunnel's access token.");
      renewFailures = 0;
      await sandbox.deletePortToken(previous.id).catch(() => {});
    })()
      .catch(() => {
        if (renewFailures++ === 0) warn("Couldn't renew the tunnel's access token; retrying. New connections fail if it expires first.");
        renewAt = Date.now() + Math.min(60_000 * renewFailures, 10 * 60_000);
      })
      .finally(() => { renewing = undefined; });
  };
  const renewal = setInterval(() => {
    if (!renewing && !closing && Date.now() >= renewAt) renew();
  }, TOKEN_RENEW_CHECK_MS);
  renewal.unref?.();

  let closed: Promise<void> | undefined;
  return {
    localPort: tunnel.port,
    url: `http://127.0.0.1:${tunnel.port}`,
    close: () => closed ??= (async () => {
      clearInterval(renewal);
      closing = true;
      wakeSleeper?.();
      // Let a renewal already in flight finish, so the token it made is revoked below (or by itself).
      await renewing;
      await tunnel.close();
      await keepalive?.kill().catch(() => {});
      await keepalive?.disconnect().catch(() => {});
      await keepAwake;
      await sandbox.deletePortToken(access.id).catch(() => {});
    })(),
  };
}

/**
 * Starts a sandbox's desktop and serves it on 127.0.0.1 (port 6080 unless
 * taken). Open `viewerUrl` in a browser on this machine.
 */
export async function openDesktopTunnel(
  sandbox: Sandbox,
  options: ForwardPortOptions = {},
): Promise<ForwardedPort & { viewerUrl: string }> {
  const { token } = await sandbox.desktop.start();
  const forwarded = await forwardPort(sandbox, DESKTOP_PORT, options);
  return { ...forwarded, viewerUrl: `${forwarded.url}${desktopViewerPath(token)}` };
}
