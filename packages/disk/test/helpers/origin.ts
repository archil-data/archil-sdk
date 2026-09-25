import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export interface CannedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Drop the connection instead of answering, like a transport failure. */
  destroy?: boolean;
}

export type Respond = (request: RecordedRequest) => CannedResponse | Promise<CannedResponse>;

function headerPairs(headers: IncomingHttpHeaders): [string, string][] {
  return Object.entries(headers).flatMap(([name, value]): [string, string][] => {
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((v) => [name, v]);
  });
}

// A local HTTP/1.1 origin standing in for the control plane or the S3 gateway.
// Records every request so tests assert on what the SDK's real transport sent.
export async function startOrigin(respond: Respond) {
  const requests: RecordedRequest[] = [];
  let connections = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded: RecordedRequest = {
      method: req.method ?? "",
      url: new URL(req.url ?? "/", `http://${req.headers.host}`),
      headers: new Headers(headerPairs(req.headers)),
      body: Buffer.concat(chunks).toString(),
    };
    requests.push(recorded);
    const canned = await respond(recorded);
    if (canned.destroy) {
      req.socket.destroy();
      return;
    }
    const { status = 200, headers = {}, body = "" } = canned;
    res.writeHead(status, headers);
    res.end(body);
  });
  server.on("connection", () => {
    connections += 1;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    get connections() {
      return connections;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export function json(body: unknown, status = 200): CannedResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function xml(body: string): CannedResponse {
  return { status: 200, headers: { "content-type": "application/xml" }, body };
}
