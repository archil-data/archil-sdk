import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createApiClient, type ApiClient } from "../src/client.js";
import { ArchilError, ImageBuildError } from "../src/errors.js";
import { Images } from "../src/images.js";
import { json, startOrigin, type CannedResponse } from "./helpers/origin.js";

const now = "2026-10-01T12:00:00Z";
const imageId = "a".repeat(64);
const source = "ghcr.io/acme/app:v1";
const registryAuth = { username: "bot", password: "registry-secret" };

function imageWire(status: string, overrides: Record<string, unknown> = {}) {
  return {
    image_id: imageId,
    source,
    private: true,
    status,
    created_at: now,
    updated_at: now,
    vcpu_count: 1,
    mem_size_mib: 2048,
    ...overrides,
  };
}

// Answers every call with the next response; the last one repeats.
function fakeImages(...responses: object[]) {
  const calls: Array<{ method: string; options: any; ms: number }> = [];
  const start = Date.now();
  const respond = (method: string) => async (_path: string, options: unknown) => {
    calls.push({ method, options, ms: Date.now() - start });
    const data = responses.length > 1 ? responses.shift() : responses[0];
    return { data: { success: true, data }, response: new Response(null, { status: 200 }) };
  };
  const images = new Images({ GET: respond("GET"), POST: respond("POST") } as unknown as ApiClient);
  return { calls, images };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("build retries a transient failure and returns a ready image without polling", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const responses: CannedResponse[] = [
    json({ success: false, error: "no runtime host available", code: "no_capacity" }, 503),
    json({
      success: true,
      data: imageWire("ready", { digest: "sha256:abc", canonical_source: "ghcr.io/acme/app@sha256:abc" }),
    }, 202),
  ];
  const control = await startOrigin(() => responses.shift() ?? json({ success: false, error: "unexpected request" }, 500));
  try {
    const images = new Images(createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url }));
    assert.deepEqual(await images.build({ source, registryAuth }), {
      imageId,
      source,
      private: true,
      status: "ready",
      digest: "sha256:abc",
      canonicalSource: "ghcr.io/acme/app@sha256:abc",
      failureReason: undefined,
      buildLog: undefined,
      vcpuCount: 1,
      memSizeMiB: 2048,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    assert.deepEqual(
      control.requests.map(({ method, url, body }) => ({ method, path: url.pathname, body: JSON.parse(body) })),
      Array(2).fill({ method: "POST", path: "/api/images", body: { source, registry_auth: registryAuth } }),
    );
  } finally {
    await control.close();
  }
});

test("build polls a running build with backoff until it is ready", async () => {
  vi.useFakeTimers();
  const { calls, images } = fakeImages(imageWire("building"), imageWire("building"), imageWire("ready"));
  const building = images.build({ source });
  await vi.advanceTimersByTimeAsync(3_000);
  assert.equal((await building).status, "ready");
  assert.deepEqual(calls, [
    { method: "POST", options: { body: { source, registry_auth: undefined, vcpu_count: undefined, mem_size_mib: undefined } }, ms: 0 },
    { method: "GET", options: { params: { path: { image_id: imageId } } }, ms: 1_000 },
    { method: "GET", options: { params: { path: { image_id: imageId } } }, ms: 3_000 },
  ]);
});

test("build requests the image at a size and returns the size its sandboxes get", async () => {
  const { calls, images } = fakeImages(imageWire("ready", { vcpu_count: 8, mem_size_mib: 16384 }));
  const image = await images.build({ source, vcpuCount: 8, memSizeMiB: 16384 });
  assert.deepEqual([image.vcpuCount, image.memSizeMiB], [8, 16384]);
  assert.deepEqual(calls[0].options, {
    body: { source, registry_auth: undefined, vcpu_count: 8, mem_size_mib: 16384 },
  });
});

test("build requests an interrupted build again with the same credentials", async () => {
  const { calls, images } = fakeImages(imageWire("failed", { failure_reason: "interrupted" }), imageWire("ready"));
  assert.equal((await images.build({ source, registryAuth })).status, "ready");
  assert.deepEqual(
    calls.map(({ method, options }) => ({ method, options })),
    Array(2).fill({ method: "POST", options: { body: { source, registry_auth: registryAuth, vcpu_count: undefined, mem_size_mib: undefined } } }),
  );
});

test.each([
  { reason: "invalid_source", requests: 1 },
  { reason: "interrupted", requests: 4 },
])("build throws $reason after $requests requests", async ({ reason, requests }) => {
  const { calls, images } = fakeImages(imageWire("failed", { failure_reason: reason }));
  await assert.rejects(images.build({ source }), (error: unknown) => {
    assert.ok(error instanceof ImageBuildError);
    assert.equal(error.reason, reason);
    assert.equal(error.code, "IMAGE_BUILD_FAILED");
    assert.equal(error.latest.imageId, imageId);
    return true;
  });
  assert.deepEqual(calls.map(({ method }) => method), Array(requests).fill("POST"));
});

test("build requests a long-running build again every two minutes", async () => {
  vi.useFakeTimers();
  const { calls, images } = fakeImages(imageWire("building"));
  const timedOut = assert.rejects(images.build({ source }, { timeoutSeconds: 125 }), ArchilError);
  await vi.advanceTimersByTimeAsync(127_000);
  await timedOut;
  assert.deepEqual(calls.filter(({ method }) => method === "POST").map(({ ms }) => ms), [0, 122_000]);
});

test("build returns a build found ready at the two-minute check instead of requesting it again", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const methods: string[] = [];
  const respond = (method: string) => async () => {
    methods.push(method);
    const status = method === "GET" && Date.now() - start >= 120_000 ? "ready" : "building";
    return { data: { success: true, data: imageWire(status) }, response: new Response(null, { status: 200 }) };
  };
  const images = new Images({ GET: respond("GET"), POST: respond("POST") } as unknown as ApiClient);
  const built = images.build({ source });
  await vi.advanceTimersByTimeAsync(123_000);
  assert.equal((await built).status, "ready");
  assert.equal(methods.filter((method) => method === "POST").length, 1);
});

test("build throws once the timeout passes", async () => {
  vi.useFakeTimers();
  const { calls, images } = fakeImages(imageWire("building"));
  const timedOut = assert.rejects(images.build({ source }, { timeoutSeconds: 10 }), (error: unknown) => {
    assert.ok(error instanceof ArchilError);
    assert.equal(error.code, "IMAGE_BUILD_TIMEOUT");
    return true;
  });
  await vi.advanceTimersByTimeAsync(12_000);
  await timedOut;
  assert.deepEqual(calls.map(({ ms }) => ms), [0, 1_000, 3_000, 7_000, 12_000]);
});

const dockerfile = "FROM alpine:3\nCOPY main.c /src/\n";

async function contextDirectory(): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "archil-images-"));
  await writeFile(join(root, "main.c"), "int main(void) { return 0; }\n");
  return root;
}

// POST /api/images/contexts answers with `upload`; POST /api/images with a ready image.
function fakeDockerfileImages(upload: object) {
  const posts: Array<{ path: string; body: any }> = [];
  const images = new Images({
    POST: async (path: string, options: { body: unknown }) => {
      posts.push({ path, body: options.body });
      const data = path === "/api/images/contexts" ? upload : imageWire("ready");
      return { data: { success: true, data }, response: new Response(null, { status: 200 }) };
    },
  } as unknown as ApiClient);
  return { images, posts };
}

test("build from a Dockerfile uploads its context to the presigned URL", async () => {
  const { packContext } = await import("../src/build-context.js");
  const root = await contextDirectory();
  const { data, sha256 } = await packContext(root);
  const bucket = await startOrigin(() => ({ status: 200 }));
  try {
    const { images, posts } = fakeDockerfileImages({
      present: false,
      upload_url: `${bucket.url}/contexts/u/ctx.tar.gz?X-Amz-Signature=sig`,
      upload_headers: { "x-amz-checksum-sha256": "c3VtCg==" },
    });

    await images.build({ dockerfile, context: root });

    assert.deepEqual(posts, [
      { path: "/api/images/contexts", body: { sha256, size_bytes: data.length } },
      {
        path: "/api/images",
        body: { dockerfile, context: `sha256:${sha256}`, vcpu_count: undefined, mem_size_mib: undefined },
      },
    ]);
    const [upload] = bucket.requests;
    assert.equal(upload.method, "PUT");
    assert.equal(upload.url.pathname, "/contexts/u/ctx.tar.gz");
    assert.equal(upload.headers.get("content-length"), String(data.length));
    assert.equal(upload.headers.get("x-amz-checksum-sha256"), "c3VtCg==");
    assert.equal(upload.headers.get("authorization"), null);
  } finally {
    await bucket.close();
  }
});

test("build from a Dockerfile skips a context already uploaded", async () => {
  const { images, posts } = fakeDockerfileImages({ present: true });

  await images.build({ dockerfile, context: await contextDirectory(), vcpuCount: 2 });

  assert.deepEqual(posts.map(({ path }) => path), ["/api/images/contexts", "/api/images"]);
  assert.equal(posts[1].body.vcpu_count, 2);
});

test("build from a Dockerfile without a context sends only the Dockerfile", async () => {
  const { calls, images } = fakeImages(imageWire("ready"));

  await images.build({ dockerfile });

  assert.deepEqual(calls.map(({ options }) => JSON.parse(JSON.stringify(options.body))), [{ dockerfile }]);
});

test("build rejects conflicting arguments before any request", async () => {
  const { calls, images } = fakeImages(imageWire("ready"));
  for (const request of [{}, { source, dockerfile }, { source, context: "." }, { dockerfile, registryAuth }]) {
    await assert.rejects(images.build(request), TypeError);
  }
  assert.equal(calls.length, 0);
});

test("a failed Dockerfile build throws with the end of its log", async () => {
  const log = `${Array.from({ length: 30 }, (_, n) => `#${n} step`).join("\n")}\nERROR: exit code: 3`;
  const { images } = fakeImages(imageWire("failed", { failure_reason: "invalid_source", build_log: log }));

  await assert.rejects(images.build({ dockerfile }), (error: unknown) => {
    assert.ok(error instanceof ImageBuildError);
    assert.equal(error.latest.buildLog, log);
    assert.ok(error.message.endsWith("ERROR: exit code: 3"));
    assert.ok(!error.message.includes("#10 step"));
    return true;
  });
});
