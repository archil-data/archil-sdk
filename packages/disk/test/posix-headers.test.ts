import assert from "node:assert/strict";
import { test } from "vitest";
import { Archil, Workspace } from "../src/index.js";
import type { Disk } from "../src/index.js";
import { json, startOrigin, xml, type RecordedRequest } from "./helpers/origin.js";

// Serve the control-plane disk list from one local origin and a permissive S3
// gateway from another, recording every S3 request so tests can assert on its headers.
async function withMockedS3(
  run: (disk: Disk, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const control = await startOrigin((request) => {
    if (request.url.pathname === "/api/disks") {
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
    return json({ success: false, error: `unexpected request: ${request.method} ${request.url}` }, 500);
  });
  const s3 = await startOrigin((request) => {
    if (request.method === "POST" && request.url.searchParams.has("uploads")) {
      return xml(
        "<InitiateMultipartUploadResult><UploadId>up-1</UploadId><Key>k</Key><Bucket>dsk-1</Bucket></InitiateMultipartUploadResult>",
      );
    }
    if (request.method === "POST" && request.url.searchParams.has("uploadId")) {
      return xml('<CompleteMultipartUploadResult><ETag>"composite-1"</ETag></CompleteMultipartUploadResult>');
    }
    return { status: 200, headers: { etag: '"ok"' } };
  });

  try {
    const archil = new Archil({
      apiKey: "key-test",
      region: "aws-us-east-1",
      baseUrl: control.url,
      s3BaseUrl: s3.url,
    });
    const [disk] = await archil.disks.list();
    await run(disk, s3.requests);
  } finally {
    await Promise.all([control.close(), s3.close()]);
  }
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

test("putObject preserves a directory-marker path and sends POSIX headers", async () => {
  await withMockedS3(async (disk, requests) => {
    await disk.putObject("path/a/private/", "", { mode: 0o750, uid: 4000, gid: 4001 });
    const put = requests.find((r) => r.method === "PUT");
    assert.ok(put, "expected a PUT request");
    assert.equal(put.url.pathname, "/dsk-1/path/a/private/");
    assert.equal(put.headers.get("x-archil-mode"), "750");
    assert.equal(put.headers.get("x-archil-uid"), "4000");
    assert.equal(put.headers.get("x-archil-gid"), "4001");
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
