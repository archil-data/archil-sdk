import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createSecureServer, type Http2ServerResponse, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates } from "node:tls";
import { afterAll, beforeAll, test } from "vitest";
import { getGlobalDispatcher } from "undici";
import { Archil, type ArchilOptions } from "../src/index.js";

let directory: string;
let ca: string;
let otherCa: string;
let key: Buffer;
let cert: Buffer;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "archil-client-tls-"));
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  for (const name of ["ca", "other-ca"]) {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-subj", `/CN=Archil SDK test ${name}`, "-keyout", `${name}.key`, "-out", `${name}.pem`,
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  }
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
  otherCa = readFileSync(join(directory, "other-ca.pem"), "utf8");
  key = readFileSync(join(directory, "server.key"));
  cert = readFileSync(join(directory, "server.pem"));
}, 15_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const diskList = JSON.stringify({
  success: true,
  data: [{
    id: "dsk-test", name: "test", organization: "org-test", status: "available",
    provider: "aws", region: "aws-us-east-2", createdAt: "2026-01-01T00:00:00Z",
  }],
});

async function endpoint() {
  const sessions = new Set<ServerHttp2Session>();
  const pendingExecs: Http2ServerResponse[] = [];
  const requests: { method: string; path: string; version: string }[] = [];
  const objects = new Map<string, Buffer>();
  const server = createSecureServer({ key, cert, allowHTTP1: true });
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
  });
  server.on("request", (req, res) => {
    requests.push({ method: req.method, path: req.url, version: req.httpVersion });
    const path = new URL(req.url, "https://localhost").pathname;
    if (path === "/api/disks") {
      res.setHeader("content-type", "application/json");
      res.end(diskList);
    } else if (req.url === "/api/disks/dsk-test/exec") {
      req.resume();
      req.on("end", () => {
        // Both POSTs must arrive before either completes to prove multiplexing.
        pendingExecs.push(res);
        if (pendingExecs.length === 2) {
          for (const response of pendingExecs) {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ success: true, data: { stdout: "ok", stderr: "", exitCode: 0 } }));
          }
        }
      });
    } else if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(req.url, Buffer.concat(chunks));
        res.setHeader("etag", '"test"');
        res.end();
      });
    } else {
      res.end(objects.get(req.url) ?? Buffer.from("private object"));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `https://localhost:${(server.address() as AddressInfo).port}`,
    sessions,
    requests,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const session of sessions) session.destroy();
      await closed;
    },
  };
}

function options(baseUrl: string, tls?: ArchilOptions["tls"]): ArchilOptions {
  return { apiKey: "key-tls-test", region: "aws-us-east-2", baseUrl, tls };
}

function isUntrusted(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
}

test("private CA applies to control-plane and S3 requests without changing global trust", async () => {
  const control = await endpoint();
  const s3 = await endpoint();
  const globalDispatcher = getGlobalDispatcher();
  const defaultCAs = getCACertificates();
  try {
    const trusted = new Archil({
      ...options(control.url, { ca: [...defaultCAs, ca] }),
      s3BaseUrl: s3.url,
    });
    const [disk] = await trusted.disks.list();
    await disk.putObject("object", "hello private CA");
    assert.equal(new TextDecoder().decode(await disk.getObject("object")), "hello private CA");
    assert.ok(control.requests.every((request) => request.version === "2.0"));
    assert.ok(s3.requests.every((request) => request.version === "2.0"));
    assert.equal(s3.sessions.size, 1);

    for (const tls of [undefined, {}, { ca: [] }, { ca: otherCa }]) {
      await assert.rejects(new Archil(options(control.url, tls)).disks.list(), isUntrusted);
    }
    await assert.rejects(fetch(control.url), isUntrusted);
    assert.equal(getGlobalDispatcher(), globalDispatcher);
    assert.deepEqual(getCACertificates(), defaultCAs);
  } finally {
    await Promise.all([control.close(), s3.close()]);
  }
});

test("S3 rejects a private CA without client trust even after a trusted client connects", async () => {
  const s3 = await endpoint();
  const control = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(diskList);
  });
  control.listen(0, "127.0.0.1");
  await once(control, "listening");
  const baseUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  try {
    const trusted = new Archil({ ...options(baseUrl, { ca }), s3BaseUrl: s3.url });
    const [disk] = await trusted.disks.list();
    assert.equal(new TextDecoder().decode(await disk.getObject("object")), "private object");
    for (const tls of [undefined, { ca: otherCa }]) {
      const untrusted = new Archil({ ...options(baseUrl, tls), s3BaseUrl: s3.url });
      const [untrustedDisk] = await untrusted.disks.list();
      await assert.rejects(untrustedDisk.getObject("object"), isUntrusted);
    }
  } finally {
    control.closeAllConnections();
    await Promise.all([
      s3.close(),
      new Promise<void>((resolve, reject) => control.close((error) => error ? reject(error) : resolve())),
    ]);
  }
});

test("matching CAs share an HTTP/2 session and multiplex POSTs; different CAs stay isolated", async () => {
  const control = await endpoint();
  try {
    const first = new Archil(options(control.url, { ca }));
    const second = new Archil(options(control.url, { ca: [Buffer.from(ca)] }));
    const results = await Promise.all([
      first.disks.exec("dsk-test", "echo first"),
      second.disks.exec("dsk-test", "echo second"),
    ]);
    assert.deepEqual(results.map((result) => result.stdout), ["ok", "ok"]);
    assert.equal(control.sessions.size, 1);
    assert.ok(control.requests.every((request) => request.version === "2.0"));

    const differentTrust = new Archil(options(control.url, { ca: [ca, otherCa] }));
    await differentTrust.disks.list();
    assert.equal(control.sessions.size, 2);
  } finally {
    await control.close();
  }
});

test("custom CA does not bypass hostname verification", async () => {
  const control = await endpoint();
  try {
    const client = new Archil(options(control.url.replace("localhost", "127.0.0.1"), { ca }));
    await assert.rejects(client.disks.list(), (error: unknown) =>
      (error as { cause?: { code?: string } }).cause?.code === "ERR_TLS_CERT_ALTNAME_INVALID");
  } finally {
    await control.close();
  }
});

test("CA arrays and buffers are snapshotted before the first request", async () => {
  const control = await endpoint();
  try {
    const buffer = Buffer.from(ca);
    const tls = { ca: [buffer] };
    const client = new Archil(options(control.url, tls));
    buffer.fill(0);
    tls.ca.splice(0, 1, Buffer.from(otherCa));
    assert.equal((await client.disks.list())[0].id, "dsk-test");
    await new Archil(options(control.url, { ca })).disks.list();
    assert.equal(control.sessions.size, 1);
  } finally {
    await control.close();
  }
});
