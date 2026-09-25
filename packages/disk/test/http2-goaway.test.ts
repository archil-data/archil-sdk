import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  constants,
  createSecureServer,
  type Http2ServerResponse,
  type Http2Session,
  type ServerHttp2Session,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { Archil } from "../src/index.js";

// A load balancer retiring a long-lived HTTP/2 session sends GOAWAY(NO_ERROR)
// while control-plane requests are in flight. Streams at or below the frame's
// lastStreamID must still complete; streams above it were never processed and
// must be replayed on a fresh session.

let directory: string;
let ca: string;
let key: Buffer;
let cert: Buffer;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "archil-goaway-"));
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
    "-subj", "/CN=Archil SDK goaway test ca", "-keyout", "ca.key", "-out", "ca.pem",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
    "-keyout", "server.key", "-out", "server.csr");
  writeFileSync(join(directory, "server.ext"), [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:localhost",
  ].join("\n"));
  openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "server.pem", "-days", "2", "-sha256", "-extfile", "server.ext");
  ca = readFileSync(join(directory, "ca.pem"), "utf8");
  key = readFileSync(join(directory, "server.key"));
  cert = readFileSync(join(directory, "server.pem"));
}, 15_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const diskJson = JSON.stringify({
  success: true,
  data: {
    id: "dsk-test", name: "test", organization: "org-test", status: "available",
    provider: "aws", region: "aws-us-east-2", createdAt: "2026-01-01T00:00:00Z",
  },
});

function respond(res: Http2ServerResponse) {
  res.setHeader("content-type", "application/json");
  res.end(diskJson);
}

interface Held { res: Http2ServerResponse; id: number }

// Holds the first `count` requests, then hands them (in stream-id order) to
// `retire`, which plays the load balancer. Every later request is answered at once.
async function endpoint(count: number, retire: (session: Http2Session, held: Held[]) => void) {
  const sessions = new Set<ServerHttp2Session>();
  const held: Held[] = [];
  let retired = false;
  const server = createSecureServer({ key, cert });
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
  });
  server.on("request", (req, res) => {
    if (retired) return respond(res);
    held.push({ res, id: req.stream.id! });
    if (held.length !== count) return;
    retired = true;
    held.sort((a, b) => a.id - b.id);
    retire(req.stream.session!, held);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `https://localhost:${(server.address() as AddressInfo).port}`,
    sessions,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const session of sessions) session.destroy();
      await closed;
    },
  };
}

function client(baseUrl: string) {
  return new Archil({ apiKey: "key-goaway-test", region: "aws-us-east-2", baseUrl, tls: { ca } });
}

function describeError(error: unknown): string {
  const e = error as { message?: string; cause?: { code?: string; message?: string } };
  return `${e.message}${e.cause ? ` <- [${e.cause.code}] ${e.cause.message}` : ""}`;
}

function settle(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "ok", describeError);
}

test("GOAWAY(NO_ERROR) covering every in-flight stream lets those GETs complete", async () => {
  const control = await endpoint(3, (session, held) => {
    // lastStreamID = highest accepted stream: the server promises to process all of them.
    session.goaway(constants.NGHTTP2_NO_ERROR, held[held.length - 1].id);
    for (const h of held) respond(h.res);
    session.close();
  });
  try {
    const archil = client(control.url);
    const inFlight = await Promise.all([1, 2, 3].map(() => settle(archil.disks.get("dsk-test"))));
    assert.deepEqual(inFlight, ["ok", "ok", "ok"]);
    assert.equal(await settle(archil.disks.get("dsk-test")), "ok", "the next request reconnects");
    assert.equal(control.sessions.size, 2);
  } finally {
    await control.close();
  }
});

test("GOAWAY(NO_ERROR) on an idle session is invisible to the next request", async () => {
  let lastId = 0;
  const control = await endpoint(1, (_session, held) => {
    lastId = held[0].id;
    respond(held[0].res);
  });
  try {
    const archil = client(control.url);
    assert.equal(await settle(archil.disks.get("dsk-test")), "ok");
    const [session] = control.sessions;
    const closed = once(session, "close");
    session.goaway(constants.NGHTTP2_NO_ERROR, lastId);
    session.close();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await settle(archil.disks.get("dsk-test")), "ok");
    assert.equal(control.sessions.size, 2);
  } finally {
    await control.close();
  }
});

test("GOAWAY(NO_ERROR) that refuses the newest stream completes the older GETs and replays the refused one", async () => {
  const control = await endpoint(3, (session, held) => {
    const [first, second, refused] = held;
    // The newest stream is above lastStreamID: per RFC 9113 §6.8 the server did not process it.
    session.goaway(constants.NGHTTP2_NO_ERROR, second.id);
    respond(first.res);
    respond(second.res);
    refused.res.stream.close(constants.NGHTTP2_REFUSED_STREAM);
    session.close();
  });
  try {
    const archil = client(control.url);
    const inFlight = await Promise.all([1, 2, 3].map(() => settle(archil.disks.get("dsk-test"))));
    assert.deepEqual(inFlight, ["ok", "ok", "ok"]);
    assert.equal(control.sessions.size, 2, "the refused GET is replayed on a fresh session");
  } finally {
    await control.close();
  }
});
