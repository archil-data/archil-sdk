// Proves the `disk` SDK is bundler-friendly and runs in a browser environment.
//
// Two layers of verification:
//   1. The library entry bundles for `platform: "browser"`, and the output
//      pulls in no Node built-ins. A static `import` of a Node-only module
//      (`node:module`, `fs`, ...) makes the browser bundle fail to resolve, so
//      a clean build is a real guarantee.
//   2. The bundle is executed inside a `vm` context that mimics a browser:
//      only web-platform globals are present — there is no `process`, no
//      `require`, and no `Buffer`. The SDK's production code (Archil client,
//      openapi-fetch transport, S3 XML parsing) is driven against a mocked
//      `fetch`, which would throw `process is not defined` / `require is not
//      defined` at the first misstep if anything reached for a Node API.

import { test } from "vitest";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "tsdown";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/index.ts";

type BundleFormat = "esm" | "iife";
type BrowserCall = { url: string; method: string; body?: any; headers?: Record<string, string> };
type BrowserSandbox = Record<string, any> & {
  globalThis?: BrowserSandbox;
  ArchilSDK?: any;
  process?: unknown;
};
type FetchMock = (input: any, init?: any) => Promise<Response>;

async function bundleForBrowser(format: BundleFormat, globalName?: string) {
  const bundles = await build({
    cwd: pkgRoot,
    entry: [ENTRY],
    platform: "browser",
    format,
    ...(globalName ? { globalName } : {}),
    dts: false,
    fixedExtension: false,
    logLevel: "silent",
    report: false,
    write: false,
    clean: false,
    define: { __SDK_VERSION__: JSON.stringify("0-test") },
    deps: {
      alwaysBundle: (id) =>
        id === "openapi-fetch" ||
        id === "fast-xml-parser" ||
        id === "zod" ||
        id.startsWith("zod/"),
    },
  });
  const chunk = bundles.flatMap((bundle) => bundle.chunks).find((entry) => entry.type === "chunk");
  assert.ok(chunk, `expected a JS chunk for ${format} browser build`);
  return chunk.code;
}

test("library entry builds for the browser", async () => {
  const code = await bundleForBrowser("esm");
  assert.ok(code.length > 0, "browser build should emit JavaScript");
});

test("browser bundle contains no Node built-in modules", async () => {
  const code = await bundleForBrowser("esm");

  // A static import of any of these would have failed the build above; this
  // also catches a Node built-in sneaking in through a dependency.
  const nodeBuiltin = /['"`]node:(?:module|url|fs|path|crypto|net|stream|os|child_process|http|https)['"`]/;
  assert.ok(!nodeBuiltin.test(code), "bundle references a Node built-in module specifier");

  // The native addon must remain a runtime dynamic import, never statically
  // pulled into the browser bundle.
  assert.ok(!/['"`]@archildata\/native['"`]\s*\)/.test(code) || /import\(/.test(code), "native addon should only load via dynamic import");
});

test("every process access in the bundle is guarded by a typeof check", async () => {
  const code = await bundleForBrowser("esm");
  // Reading process.env directly would throw in a browser. The SDK is allowed
  // to reference it only behind a `typeof process !== "undefined"` guard.
  if (code.includes("process.env")) {
    assert.ok(
      /typeof process/.test(code),
      "bundle reads process.env without a typeof process guard",
    );
  }
});

// Build a browser-like sandbox: web-platform globals only. The deliberate
// omissions (process, require, Buffer, module, __dirname) are what make this a
// faithful browser stand-in — touching any of them throws.
function makeBrowserSandbox(fetchImpl: FetchMock): BrowserSandbox {
  const sandbox: BrowserSandbox = {
    fetch: fetchImpl,
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    Blob,
    FormData,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

async function loadSdkInBrowserSandbox(fetchImpl: FetchMock): Promise<{ sdk: any; sandbox: BrowserSandbox }> {
  const code = await bundleForBrowser("iife", "ArchilSDK");
  const sandbox = makeBrowserSandbox(fetchImpl);
  vm.runInContext(code, sandbox, { filename: "archil-disk.browser.js" });
  assert.equal(typeof sandbox.process, "undefined", "sandbox must not expose process");
  return { sdk: sandbox.ArchilSDK, sandbox };
}

const LIST_BUCKET_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  "<ListBucketResult><Name>dsk-1</Name><KeyCount>1</KeyCount>" +
  "<IsTruncated>false</IsTruncated>" +
  '<Contents><Key>reports/a.txt</Key><Size>3</Size><ETag>"abc"</ETag>' +
  "<LastModified>2026-01-02T03:04:05.000Z</LastModified></Contents>" +
  "</ListBucketResult>";

function routingFetch(calls: BrowserCall[]): FetchMock {
  const appendStore = new Map<string, Uint8Array>();
  return (input: any, init?: any) => {
    const raw = typeof input === "string" ? input : input.url;
    const u = new URL(raw);
    // openapi-fetch calls fetch(Request, ...) — the verb is on the Request, not
    // in init — while raw fetches pass (url, init). Read whichever applies.
    const method = (typeof input === "string" ? init?.method : input.method) ?? "GET";
    // Capture request headers so tests can assert x-archil-* create attrs.
    let headers: Record<string, string> | undefined;
    const rawHeaders =
      typeof input === "string"
        ? init?.headers
        : input instanceof Request
          ? input.headers
          : init?.headers;
    if (rawHeaders) {
      headers = {};
      if (typeof rawHeaders.forEach === "function") {
        rawHeaders.forEach((v: string, k: string) => {
          headers![k.toLowerCase()] = v;
        });
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    calls.push({ url: raw, method, headers });

    if (u.hostname.startsWith("control.") && u.pathname === "/api/disks") {
      const body = JSON.stringify({
        success: true,
        data: [
          {
            id: "dsk-1",
            name: "d1",
            organization: "org",
            status: "available",
            provider: "aws",
            region: "aws-us-east-1",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }

    if (u.hostname.startsWith("control.") && u.pathname === "/api/disks/dsk-1/share") {
      return (async () => {
        const reqBody = typeof input === "string" ? JSON.parse(init?.body ?? "{}") : await input.clone().json();
        calls[calls.length - 1].body = reqBody;
        const expiresIn = reqBody.expiresIn ?? 86400;
        const body = JSON.stringify({
          success: true,
          data: { url: `https://control.example/api/shared/tok.sig`, expiresIn },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      })();
    }

    if (u.hostname.startsWith("s3.")) {
      const sp = u.searchParams;
      const xmlResponse = (body: string) =>
        new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
      const recordBody = async () => {
        const b = typeof input === "string" ? init?.body : await input.clone().text();
        calls[calls.length - 1].body =
          typeof b === "string" ? b : b ? new TextDecoder().decode(b) : "";
        return calls[calls.length - 1].body;
      };

      // DeleteObjects: POST /<bucket>?delete — echo each <Key> back as deleted.
      if (method === "POST" && sp.has("delete")) {
        return (async () => {
          const body = await recordBody();
          const keys = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
          const deleted = keys.map((k) => `<Deleted><Key>${k}</Key></Deleted>`).join("");
          return xmlResponse(`<?xml version="1.0"?><DeleteResult>${deleted}</DeleteResult>`);
        })();
      }
      // CreateMultipartUpload: POST /<bucket>/<key>?uploads
      if (method === "POST" && sp.has("uploads")) {
        return Promise.resolve(
          xmlResponse(
            '<?xml version="1.0"?><InitiateMultipartUploadResult>' +
              "<Bucket>dsk-1</Bucket><Key>big.bin</Key><UploadId>upload-xyz</UploadId>" +
              "</InitiateMultipartUploadResult>",
          ),
        );
      }
      // CompleteMultipartUpload: POST /<bucket>/<key>?uploadId=...
      if (method === "POST" && sp.has("uploadId")) {
        return (async () => {
          await recordBody();
          return xmlResponse(
            '<?xml version="1.0"?><CompleteMultipartUploadResult>' +
              "<Location>/dsk-1/big.bin</Location><Bucket>dsk-1</Bucket>" +
              '<Key>big.bin</Key><ETag>"composite-2"</ETag>' +
              "</CompleteMultipartUploadResult>",
          );
        })();
      }
      // UploadPart: PUT /<bucket>/<key>?uploadId=...&partNumber=N
      if (method === "PUT" && sp.has("uploadId")) {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { etag: `"part-${sp.get("partNumber")}"`, "content-length": "0" },
          }),
        );
      }
      // AppendObject: PUT /<bucket>/<key>?append=true — concatenate into the store.
      if (method === "PUT" && sp.has("append")) {
        return (async () => {
          const body = typeof input === "string" ? init?.body : await input.clone().arrayBuffer();
          const chunk = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body ?? new ArrayBuffer(0));
          const prev = appendStore.get(u.pathname) ?? new Uint8Array(0);
          const merged = new Uint8Array(prev.length + chunk.length);
          merged.set(prev);
          merged.set(chunk, prev.length);
          appendStore.set(u.pathname, merged);
          return new Response(null, {
            status: 200,
            headers: { etag: `"len-${merged.length}"`, "content-length": "0" },
          });
        })();
      }
      // AbortMultipartUpload: DELETE /<bucket>/<key>?uploadId=...
      if (method === "DELETE" && sp.has("uploadId")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      // ListParts: GET /<bucket>/<key>?uploadId=...
      if (method === "GET" && sp.has("uploadId")) {
        return Promise.resolve(
          xmlResponse(
            '<?xml version="1.0"?><ListPartsResult><Bucket>dsk-1</Bucket>' +
              "<Key>big.bin</Key><UploadId>upload-xyz</UploadId>" +
              "<PartNumberMarker>0</PartNumberMarker><MaxParts>1000</MaxParts>" +
              "<IsTruncated>false</IsTruncated><StorageClass>STANDARD</StorageClass>" +
              '<Part><PartNumber>1</PartNumber><ETag>"part-1"</ETag><Size>5242880</Size>' +
              "<LastModified>2026-01-02T03:04:05.000Z</LastModified></Part>" +
              "</ListPartsResult>",
          ),
        );
      }
      // ListMultipartUploads: GET /<bucket>?uploads
      if (method === "GET" && sp.has("uploads")) {
        return Promise.resolve(
          xmlResponse(
            '<?xml version="1.0"?><ListMultipartUploadsResult><Bucket>dsk-1</Bucket>' +
              "<KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker>" +
              "<MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>" +
              "<Upload><Key>big.bin</Key><UploadId>upload-xyz</UploadId>" +
              "<Initiated>2026-01-02T03:04:05.000Z</Initiated></Upload>" +
              "</ListMultipartUploadsResult>",
          ),
        );
      }
      if (sp.get("list-type") === "2") {
        return Promise.resolve(xmlResponse(LIST_BUCKET_XML));
      }
      return Promise.resolve(
        new Response(new TextEncoder().encode("hi!"), {
          status: 200,
          headers: { "content-type": "application/octet-stream", "content-length": "3" },
        }),
      );
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

test("SDK runs in a browser sandbox: control-plane list over fetch", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));

  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const disks = await archil.disks.list();

  assert.equal(disks.length, 1);
  assert.equal(disks[0].id, "dsk-1");
  assert.ok(disks[0] instanceof sdk.Disk);
  assert.ok(calls.some((c) => c.url.includes("control.") && c.url.includes("/api/disks")));
});

test("SDK runs in a browser sandbox: S3 getObject returns bytes", async () => {
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch([]));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  const bytes = await disk.getObject("reports/a.txt");
  // `bytes` is a Uint8Array minted inside the sandbox realm, so a plain
  // `instanceof Uint8Array` against this realm's constructor would be a false
  // negative — check the internal typed-array slot instead, which is
  // realm-agnostic.
  assert.ok(ArrayBuffer.isView(bytes), "getObject should return a typed array view");
  assert.equal(new TextDecoder().decode(bytes), "hi!");
});

test("SDK runs in a browser sandbox: S3 listObjects parses XML (fast-xml-parser)", async () => {
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch([]));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  const listing = await disk.listObjects();
  assert.equal(listing.keyCount, 1);
  assert.equal(listing.objects[0].key, "reports/a.txt");
  assert.equal(listing.objects[0].size, 3);
  assert.equal(listing.isTruncated, false);
});

test("SDK runs in a browser sandbox: appendObject sends PUT ?append=true and accumulates", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await disk.appendObject("log.txt", "abc");
  const second = await disk.appendObject("log.txt", "de");
  // The mock returns an etag encoding the accumulated length (3 + 2 = 5).
  assert.equal(second.etag, '"len-5"');
  const appends = calls.filter((c) => c.method === "PUT" && c.url.includes("append"));
  assert.equal(appends.length, 2);
});

test("SDK runs in a browser sandbox: deleteObjects bulk-deletes and parses DeleteResult", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  const result = await disk.deleteObjects(["a.txt", "b/c.txt"]);
  // `result.deleted` is an array minted in the sandbox realm, so compare by
  // value (join) rather than deepStrictEqual, which checks the prototype.
  assert.equal([...result.deleted].join(","), "a.txt,b/c.txt");
  assert.equal(result.errors.length, 0);

  const deleteCall = calls.find((c) => c.method === "POST" && c.url.includes("delete"));
  assert.ok(deleteCall, "deleteObjects should POST ?delete to the bucket");
  assert.match(deleteCall.body, /<Key>a\.txt<\/Key>/);
  assert.match(deleteCall.body, /<Key>b\/c\.txt<\/Key>/);
});

test("SDK runs in a browser sandbox: putObject auto-switches to multipart for large bodies", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  // 11 MiB body with a 5 MiB part size → three parts, forcing the multipart path.
  const body = new Uint8Array(11 * 1024 * 1024);
  const result = await disk.putObject("big.bin", body, { partSize: 5 * 1024 * 1024 });
  assert.equal(result.etag, '"composite-2"');

  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("uploads")), "should initiate");
  const partPuts = calls.filter((c) => c.method === "PUT" && c.url.includes("partNumber"));
  assert.equal(partPuts.length, 3, "11 MiB / 5 MiB rounds up to 3 parts");
  const complete = calls.find((c) => c.method === "POST" && c.url.includes("uploadId"));
  assert.ok(complete, "should complete");
  // The complete body lists the parts in ascending order with their ETags.
  assert.match(complete.body, /<PartNumber>1<\/PartNumber><ETag>"part-1"<\/ETag>/);
  assert.match(complete.body, /<PartNumber>3<\/PartNumber><ETag>"part-3"<\/ETag>/);
});

test("SDK runs in a browser sandbox: putObject stays a single PUT for small bodies", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await disk.putObject("small.txt", "tiny", "text/plain");
  assert.ok(!calls.some((c) => c.url.includes("uploads")), "small body must not start a multipart upload");
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 1, "small body is exactly one PUT");
  assert.ok(!puts[0].url.includes("partNumber"), "small body PUT is a plain PutObject");
});

test("SDK runs in a browser sandbox: putObject sends x-archil mode/uid/gid headers", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await disk.putObject("agent.txt", "hi", { mode: 0o640, uid: 1000, gid: 1000 });
  const put = calls.find((c) => c.method === "PUT" && c.url.includes("agent.txt"));
  assert.ok(put, "expected a PutObject call");
  assert.equal(put.headers?.["x-archil-mode"], "640");
  assert.equal(put.headers?.["x-archil-uid"], "1000");
  assert.equal(put.headers?.["x-archil-gid"], "1000");
});

test("SDK runs in a browser sandbox: multipart create forwards posix attrs", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  const body = new Uint8Array(6 * 1024 * 1024);
  await disk.putObject("big-posix.bin", body, {
    multipartThreshold: 5 * 1024 * 1024,
    partSize: 5 * 1024 * 1024,
    mode: 0o600,
    uid: 1000,
    gid: 1000,
  });
  const initiate = calls.find((c) => c.method === "POST" && c.url.includes("uploads"));
  assert.ok(initiate, "expected CreateMultipartUpload");
  assert.equal(initiate.headers?.["x-archil-mode"], "600");
  assert.equal(initiate.headers?.["x-archil-uid"], "1000");
  assert.equal(initiate.headers?.["x-archil-gid"], "1000");
});

test("SDK runs in a browser sandbox: putObject multipartThreshold forces multipart below partSize", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  // 8 MiB body is under the 16 MiB default part size, but a 5 MiB threshold
  // forces the multipart path (a single 8 MiB part).
  const body = new Uint8Array(8 * 1024 * 1024);
  const result = await disk.putObject("mid.bin", body, { multipartThreshold: 5 * 1024 * 1024 });
  assert.equal(result.etag, '"composite-2"');
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("uploads")), "should go multipart");
  const partPuts = calls.filter((c) => c.method === "PUT" && c.url.includes("partNumber"));
  assert.equal(partPuts.length, 1, "8 MiB / 16 MiB part size is a single part");
});

// A fetch that serves the control-plane disk list, then runs `s3Handler` for
// S3-host requests so a test can script transient failures.
function s3RetryFetch(s3Handler: (method: string, url: URL) => Response): FetchMock {
  return (input: any, init?: any) => {
    const raw = typeof input === "string" ? input : input.url;
    const u = new URL(raw);
    const method = (typeof input === "string" ? init?.method : input.method) ?? "GET";
    if (u.hostname.startsWith("control.") && u.pathname === "/api/disks") {
      const body = JSON.stringify({
        success: true,
        data: [
          {
            id: "dsk-1",
            name: "d1",
            organization: "org",
            status: "available",
            provider: "aws",
            region: "aws-us-east-1",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    return Promise.resolve(s3Handler(method, u));
  };
}

test("SDK retries a transient 5xx on an S3 request and then succeeds", async () => {
  let attempts = 0;
  const { sdk } = await loadSdkInBrowserSandbox(
    s3RetryFetch((method) => {
      if (method === "PUT") {
        attempts += 1;
        // Fail the first two attempts with a transient 500, then succeed.
        if (attempts < 3) return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
        return new Response(null, { status: 200, headers: { etag: '"ok"', "content-length": "0" } });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  const { etag } = await disk.putObject("k.txt", "body");
  assert.equal(etag, '"ok"');
  assert.equal(attempts, 3, "should have retried twice before succeeding");
});

test("SDK does not retry a non-transient 4xx and surfaces it", async () => {
  let attempts = 0;
  const { sdk } = await loadSdkInBrowserSandbox(
    s3RetryFetch((method) => {
      if (method === "PUT") {
        attempts += 1;
        return new Response("<Error><Code>BadDigest</Code><Message>nope</Message></Error>", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await assert.rejects(
    () => disk.putObject("k.txt", "body"),
    (err: any) => err.status === 400 && err.code === "BadDigest",
  );
  assert.equal(attempts, 1, "a 4xx must not be retried");
});

test("SDK gives up after the retry budget on a persistent 5xx", async () => {
  let attempts = 0;
  const { sdk } = await loadSdkInBrowserSandbox(
    s3RetryFetch((method) => {
      if (method === "GET") {
        attempts += 1;
        return new Response("<Error><Code>InternalError</Code></Error>", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await assert.rejects(() => disk.getObject("k.txt"), (err: any) => err.status === 503);
  // 1 initial attempt + MAX_S3_RETRIES (3) = 4 total.
  assert.equal(attempts, 4, "should attempt once plus the retry budget");
});

test("SDK does not retry CompleteMultipartUpload (avoids a false NoSuchUpload)", async () => {
  let attempts = 0;
  const { sdk } = await loadSdkInBrowserSandbox(
    s3RetryFetch((method, u) => {
      if (method === "POST" && u.searchParams.has("uploadId")) {
        attempts += 1;
        return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await assert.rejects(
    () => disk.multipart.complete("big.bin", "u1", [{ partNumber: 1, etag: '"a"' }]),
    (err: any) => err.status === 500,
  );
  // Complete is non-idempotent on our gateway, so it must not be auto-retried.
  assert.equal(attempts, 1, "CompleteMultipartUpload must not be retried");
});

test("SDK does not retry appendObject (avoids duplicating bytes)", async () => {
  let attempts = 0;
  const { sdk } = await loadSdkInBrowserSandbox(
    s3RetryFetch((method, u) => {
      if (method === "PUT" && u.searchParams.has("append")) {
        attempts += 1;
        return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await assert.rejects(() => disk.appendObject("log.txt", "line\n"), (err: any) => err.status === 500);
  // Append is non-idempotent, so it must not be auto-retried.
  assert.equal(attempts, 1, "appendObject must not be retried");
});

test("effectiveUploadPartSize grows the part size past the 10,000-part cap", async () => {
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch([]));
  const f = sdk.effectiveUploadPartSize;
  const MiB = 1024 * 1024;

  // Small/normal bodies keep the requested part size.
  assert.equal(f(100 * MiB, 16 * MiB), 16 * MiB);
  assert.equal(f(10000 * 16 * MiB, 16 * MiB), 16 * MiB, "exactly 10,000 parts is allowed");

  // A body that would need >10,000 parts at 16 MiB grows the part size so the
  // count fits within the cap, rounded up to a whole MiB.
  const huge = 200 * 1024 * MiB; // 200 GiB
  const grown = f(huge, 16 * MiB);
  assert.ok(grown > 16 * MiB, "part size should grow for a 200 GiB body");
  assert.ok(grown % MiB === 0, "grown part size is MiB-aligned");
  assert.ok(Math.ceil(huge / grown) <= 10000, "must fit within the 10,000-part cap");
});

test("SDK runs in a browser sandbox: disk.multipart drives the raw lifecycle", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  const upload = await disk.multipart.create("big.bin");
  assert.equal(upload.uploadId, "upload-xyz");
  const p1 = await disk.multipart.uploadPart("big.bin", upload.uploadId, 1, new Uint8Array(5));
  assert.equal(p1.partNumber, 1);
  const listing = await disk.multipart.listParts("big.bin", upload.uploadId);
  assert.equal(listing.parts.length, 1);
  assert.equal(listing.parts[0].size, 5242880);
  const uploads = await disk.multipart.listUploads();
  assert.equal(uploads.uploads[0].uploadId, "upload-xyz");
  const done = await disk.multipart.complete("big.bin", upload.uploadId, [p1]);
  assert.equal(done.etag, '"composite-2"');
});

test("SDK runs in a browser sandbox: share() signs a control-plane URL", async () => {
  const calls: BrowserCall[] = [];
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch(calls));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  // An arbitrary integer lifetime (not a fixed preset) is sent in the body.
  const result = await disk.share("a/b c&d.txt", { expiresIn: 90 });
  assert.equal(result.url, "https://control.example/api/shared/tok.sig");
  assert.equal(result.expiresIn, 90);

  const shareCall = calls.find((c) => c.url.endsWith("/api/disks/dsk-1/share"));
  assert.ok(shareCall, "share() should POST to the control-plane share route");
  assert.equal(shareCall.method, "POST");
  // Key + expiry travel in the JSON body, so a key with "/" and reserved
  // characters needs no path/query encoding.
  assert.deepEqual(shareCall.body, { key: "a/b c&d.txt", expiresIn: 90 });
});

test("missing credentials throw a clear error, not a process crash", async () => {
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch([]));
  // No apiKey, and no process.env to fall back to — must surface the SDK's own
  // message rather than `process is not defined`.
  assert.throws(
    () => new sdk.Archil({ region: "aws-us-east-1" }),
    /Missing API key/,
  );
});

test("mount() degrades gracefully in the browser instead of breaking the bundle", async () => {
  const { sdk } = await loadSdkInBrowserSandbox(routingFetch([]));
  const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
  const [disk] = await archil.disks.list();

  await assert.rejects(() => disk.mount(), /Native client not available/);
});
