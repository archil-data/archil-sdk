// Support for the VNC desktop image (github.com/archil-data/sandbox-desktop).
// Inside the sandbox, `desktopctl` runs Xtigervnc, XFCE, and noVNC/websockify
// as supervised services; websockify listens on DESKTOP_PORT and only proxies
// to VNC for requests that carry the desktop's viewer token.

import { createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { Sandbox } from "../sandbox.js";

export const DESKTOP_IMAGE = "ghcr.io/archil-data/sandbox-desktop:latest";
export const DESKTOP_PORT = 6080;
/** Session cap for desktops. Viewer traffic doesn't count as activity, so they run with idle expiry off. */
export const DESKTOP_MAX_TTL_SECONDS = 4 * 60 * 60;

const PORT_TOKEN_HEADER = "X-Archil-Token";
const MAX_REQUEST_HEAD_BYTES = 16 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");
const COMMAND_NOT_FOUND = 127;

/** Starts the desktop services if needed (idempotent) and returns the viewer token. */
export async function startDesktop(sandbox: Sandbox): Promise<string> {
  const stdout = await desktopctl(sandbox, "up");
  const { token } = JSON.parse(stdout) as { token: string };
  return token;
}

/** Path on the noVNC server that opens the viewer and connects with `token`. */
export function viewerPath(token: string): string {
  const params = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
    reconnect: "1",
    path: `websockify?token=${token}`,
  });
  return `/vnc.html?${params}`;
}

/** Publishes the desktop on a public hostname; anyone with the returned link controls it. */
export async function shareDesktop(sandbox: Sandbox, token: string): Promise<string> {
  const hostname = await sandbox.exposePort(DESKTOP_PORT);
  return `https://${hostname}${viewerPath(token)}`;
}

/** Removes the public hostname, invalidates old links, and disconnects current viewers. */
export async function unshareDesktop(sandbox: Sandbox): Promise<void> {
  await sandbox.unexposePort(DESKTOP_PORT);
  await desktopctl(sandbox, "revoke");
}

async function desktopctl(sandbox: Sandbox, command: string): Promise<string> {
  const result = await sandbox.exec(`desktopctl ${command}`);
  if (result.exitCode === COMMAND_NOT_FOUND) {
    throw new Error(
      `Sandbox '${sandbox.name}' doesn't have the Archil desktop installed; create it with --desktop or from an image based on ${DESKTOP_IMAGE}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(`desktopctl ${command} failed in sandbox '${sandbox.name}': ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

export interface DesktopTunnel {
  /** Local port the tunnel listens on. */
  port: number;
  close(): Promise<void>;
}

export interface DesktopTunnelOptions {
  /** `<port>-<route>.<zone>` hostname returned with the port token. */
  hostname: string;
  portToken: string;
  /** Local port to listen on; 0 picks a free one. */
  localPort: number;
  /** Opens the upstream connection; tests replace the TLS dial. */
  connectUpstream?: (hostname: string) => Duplex;
}

/**
 * Serves a sandbox's private port on 127.0.0.1. Each local connection is
 * relayed to the port's hostname with the port token added to its first
 * request; Archil authenticates only that first request and relays the rest of
 * the connection unchanged, which covers page loads and WebSockets alike.
 */
export async function openDesktopTunnel(options: DesktopTunnelOptions): Promise<DesktopTunnel> {
  const connectUpstream = options.connectUpstream
    ?? ((hostname: string) => tlsConnect({ host: hostname, port: 443, servername: hostname }));
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    relay(client, () => connectUpstream(options.hostname), options.portToken).catch(() => client.destroy());
  });
  await listen(server, options.localPort);
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function relay(client: Socket, connectUpstream: () => Duplex, portToken: string): Promise<void> {
  const head = await readRequestHead(client);
  const upstream = connectUpstream();
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.write(addRequestHeader(head, `${PORT_TOKEN_HEADER}: ${portToken}`));
  client.pipe(upstream).pipe(client);
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
