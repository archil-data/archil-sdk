import assert from "node:assert/strict";
import { test } from "vitest";
import { Archil, Workspace } from "../src/index.js";
import type { Disk } from "../src/index.js";

interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
}

// Serve the control-plane disk list from cp.test and a permissive S3 gateway
// from s3.test, capturing every S3 request so tests can assert on its headers.
async function withMockedS3(
  run: (disk: Disk, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "cp.test" && url.pathname === "/api/disks") {
      return json({
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
    }
    if (url.host === "s3.test") {
      requests.push({ method: req.method, url, headers: req.headers });
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        return xml(
          "<InitiateMultipartUploadResult><UploadId>up-1</UploadId><Key>k</Key><Bucket>dsk-1</Bucket></InitiateMultipartUploadResult>",
        );
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        return xml(
          '<CompleteMultipartUploadResult><ETag>"composite-1"</ETag></CompleteMultipartUploadResult>',
        );
      }
      return new Response(null, { status: 200, headers: { etag: '"ok"' } });
    }
    return json({ success: false, error: `unexpected request: ${req.method} ${req.url}` }, 500);
  };

  try {
    const archil = new Archil({
      apiKey: "key-test",
      region: "aws-us-east-1",
      baseUrl: "http://cp.test",
      s3BaseUrl: "http://s3.test",
    });
    const [disk] = await archil.disks.list();
    await run(disk, requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

test("putObject sends x-archil POSIX headers, mode in octal", async () => {
  await withMockedS3(async (disk, requests) => {
    await disk.putObject("posix.txt", "hi", { mode: 0o640, uid: 1000, gid: 1000 });
    const put = requests.find((r) => r.method === "PUT");
    assert.ok(put, "expected a PUT request");
    assert.equal(put.headers.get("x-archil-mode"), "640");
    assert.equal(put.headers.get("x-archil-uid"), "1000");
    assert.equal(put.headers.get("x-archil-gid"), "1000");
  });
});

test("putObject sends no x-archil headers when POSIX attrs are omitted", async () => {
  await withMockedS3(async (disk, requests) => {
    await disk.putObject("plain.txt", "hi", "text/plain");
    const put = requests.find((r) => r.method === "PUT");
    assert.ok(put, "expected a PUT request");
    assert.equal(put.headers.get("x-archil-mode"), null);
    assert.equal(put.headers.get("x-archil-uid"), null);
    assert.equal(put.headers.get("x-archil-gid"), null);
    assert.equal(put.headers.get("content-type"), "text/plain");
  });
});

test("putObject forwards POSIX headers to CreateMultipartUpload on the multipart path", async () => {
  await withMockedS3(async (disk, requests) => {
    // A zero threshold forces the multipart path even for a tiny body.
    await disk.putObject("big.bin", "hello", {
      multipartThreshold: 0,
      mode: 0o755,
      uid: 500,
      gid: 501,
    });
    const create = requests.find((r) => r.method === "POST" && r.url.searchParams.has("uploads"));
    assert.ok(create, "expected a CreateMultipartUpload request");
    assert.equal(create.headers.get("x-archil-mode"), "755");
    assert.equal(create.headers.get("x-archil-uid"), "500");
    assert.equal(create.headers.get("x-archil-gid"), "501");
    // The attributes ride on the create, not on the individual part uploads.
    const part = requests.find((r) => r.method === "PUT" && r.url.searchParams.has("partNumber"));
    assert.ok(part, "expected an UploadPart request");
    assert.equal(part.headers.get("x-archil-mode"), null);
  });
});

test("appendObject accepts options with POSIX attrs and a contentType", async () => {
  await withMockedS3(async (disk, requests) => {
    await disk.appendObject("logs/app.log", "line\n", {
      contentType: "text/plain",
      mode: 0o600,
      uid: 42,
      gid: 43,
    });
    const put = requests.find((r) => r.method === "PUT" && r.url.searchParams.get("append") === "true");
    assert.ok(put, "expected an append PUT request");
    assert.equal(put.headers.get("x-archil-mode"), "600");
    assert.equal(put.headers.get("x-archil-uid"), "42");
    assert.equal(put.headers.get("x-archil-gid"), "43");
    assert.equal(put.headers.get("content-type"), "text/plain");
  });
});

test("appendObject still accepts a plain content-type string", async () => {
  await withMockedS3(async (disk, requests) => {
    await disk.appendObject("logs/app.log", "line\n", "text/plain");
    const put = requests.find((r) => r.method === "PUT" && r.url.searchParams.get("append") === "true");
    assert.ok(put, "expected an append PUT request");
    assert.equal(put.headers.get("content-type"), "text/plain");
    assert.equal(put.headers.get("x-archil-mode"), null);
  });
});

test("Workspace.putObject forwards POSIX attrs to the routed disk", async () => {
  await withMockedS3(async (disk, requests) => {
    const ws = new Workspace(
      { exec: () => Promise.reject(new Error("unused")) },
      { data: disk },
    );
    await ws.putObject("data/posix.txt", "hi", { mode: 0o640, uid: 1000, gid: 1000 });
    const put = requests.find((r) => r.method === "PUT");
    assert.ok(put, "expected a PUT request");
    assert.equal(put.headers.get("x-archil-mode"), "640");
    assert.equal(put.headers.get("x-archil-uid"), "1000");
    assert.equal(put.headers.get("x-archil-gid"), "1000");
  });
});

test("multipart.create sends POSIX headers from its attrs argument", async () => {
  await withMockedS3(async (disk, requests) => {
    const upload = await disk.multipart.create("manual.bin", "application/octet-stream", {
      mode: 0o444,
      uid: 7,
    });
    assert.equal(upload.uploadId, "up-1");
    const create = requests.find((r) => r.method === "POST" && r.url.searchParams.has("uploads"));
    assert.ok(create, "expected a CreateMultipartUpload request");
    assert.equal(create.headers.get("x-archil-mode"), "444");
    assert.equal(create.headers.get("x-archil-uid"), "7");
    assert.equal(create.headers.get("x-archil-gid"), null);
  });
});
