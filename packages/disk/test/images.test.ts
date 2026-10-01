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
    { method: "POST", options: { body: { source, registry_auth: undefined } }, ms: 0 },
    { method: "GET", options: { params: { path: { image_id: imageId } } }, ms: 1_000 },
    { method: "GET", options: { params: { path: { image_id: imageId } } }, ms: 3_000 },
  ]);
});

test("build requests an interrupted build again with the same credentials", async () => {
  const { calls, images } = fakeImages(imageWire("failed", { failure_reason: "interrupted" }), imageWire("ready"));
  assert.equal((await images.build({ source, registryAuth })).status, "ready");
  assert.deepEqual(
    calls.map(({ method, options }) => ({ method, options })),
    Array(2).fill({ method: "POST", options: { body: { source, registry_auth: registryAuth } } }),
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
