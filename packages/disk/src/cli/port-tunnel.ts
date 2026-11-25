// Serves a sandbox's private port on 127.0.0.1. Each local connection is
// relayed over TLS to the port's `<port>-<route>.<zone>` hostname with the
// Archil port token added to its first request. Archil authenticates only that
// first request and then relays the connection unchanged, so this carries
// HTTP and WebSockets but not protocols that don't start with an HTTP request.

import { createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

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
    relay(client, () => connectUpstream(options.hostname), portToken, (head) => {
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

async function relay(client: Socket, connectUpstream: () => Duplex, portToken: string, onHead: (head: Buffer) => void): Promise<void> {
  const head = await readRequestHead(client);
  onHead(head);
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
