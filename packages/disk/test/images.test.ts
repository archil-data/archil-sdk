import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createApiClient, type ApiClient } from "../src/client.js";
import { ImageBuildError } from "../src/errors.js";
import { Images } from "../src/images.js";
import { Sandboxes } from "../src/sandboxes.js";
import { json, startOrigin } from "./helpers/origin.js";

const now = "2026-09-25T12:00:00Z";
const digest = `sha256:${"a".repeat(64)}`;

function imageWire(status: string, extra: Record<string, unknown> = {}) {
  return {
    image_id: "b".repeat(64),
    source: "ghcr.io/acme/app:v1",
    private: true,
    status,
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

function ok(data: unknown) {
  return { data: { success: true, data }, response: new Response(null, { status: 200 }) };
}

afterEach(() => {
  vi.useRealTimers();
});

test("create and get use the images endpoints and the snake_case wire format", async () => {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const control = await startOrigin((request) => {
    requests.push({ method: request.method, path: request.url.pathname, body: request.body });
    return json({
      success: true,
      data: request.method === "POST"
        ? imageWire("building")
        : imageWire("ready", { digest, canonical_source: `ghcr.io/acme/app@sha256:${"c".repeat(64)}` }),
    });
  });
  try {
    const images = new Images(createApiClient({ apiKey: "test", region: "aws-us-east-1", baseUrl: control.url }));
    const building = await images.create(
      { source: "ghcr.io/acme/app:v1", registryAuth: { username: "octocat", password: "ghp_token" } },
      { wait: false },
    );
    const ready = await images.get(building.id);

    assert.equal(ready.digest, digest);
    assert.equal(ready.canonicalSource, `ghcr.io/acme/app@sha256:${"c".repeat(64)}`);
    assert.deepEqual(JSON.parse(requests[0].body), {
      source: "ghcr.io/acme/app:v1",
      registry_auth: { username: "octocat", password: "ghp_token" },
    });
    assert.deepEqual(
      requests.map(({ method, path }) => `${method} ${path}`),
      ["POST /api/images", `GET /api/images/${"b".repeat(64)}`],
    );
  } finally {
    await control.close();
  }
});

test("create polls a building image until it is ready", async () => {
  vi.useFakeTimers();
  let gets = 0;
  const client = {
    POST: async () => ok(imageWire("building")),
    GET: async () => ok(++gets < 2 ? imageWire("building") : imageWire("ready", { digest })),
  } as unknown as ApiClient;

  const creating = new Images(client).create({ source: "ghcr.io/acme/app:v1" });
  await vi.advanceTimersByTimeAsync(2_000);
  const image = await creating;

  assert.equal(image.status, "ready");
  assert.equal(image.digest, digest);
  assert.equal(gets, 2);
});

test("create throws ImageBuildError when the build fails", async () => {
  const client = {
    POST: async () => ok(imageWire("failed", { failure_reason: "image not found, or the registry denied access" })),
  } as unknown as ApiClient;

  await assert.rejects(
    new Images(client).create({ source: "ghcr.io/acme/missing:v1" }),
    (error: unknown) =>
      error instanceof ImageBuildError &&
      error.message === "Image build failed: image not found, or the registry denied access" &&
      error.latest.status === "failed",
  );
});

test("create can return a building image without waiting", async () => {
  const client = { POST: async () => ok(imageWire("building")) } as unknown as ApiClient;

  const image = await new Images(client).create({ source: "node:24" }, { wait: false });

  assert.equal(image.status, "building");
  assert.equal(image.digest, undefined);
});

test("sandboxes boot a ready image or its digest, and refuse an unready one", async () => {
  const bodies: unknown[] = [];
  const client = {
    POST: async (_path: string, options: { body: unknown }) => {
      bodies.push(options.body);
      return ok({
        sandbox_id: "0198-sandbox",
        name: "from-image",
        status: "running",
        vcpu_count: 1,
        mem_size_mib: 2048,
        base_image: digest,
        image_digest: digest,
        max_ttl_seconds: 3600,
        max_concurrent_execs: 32,
        created_at: now,
        last_active_at: now,
      });
    },
  } as unknown as ApiClient;
  const sandboxes = new Sandboxes(client);
  const ready = { ...imageWire("ready"), id: "b".repeat(64), status: "ready", digest } as never;

  const sandbox = await sandboxes.create({ image: ready });
  await sandboxes.create({ image: digest });

  assert.equal(sandbox.imageDigest, digest);
  assert.deepEqual(bodies.map((body) => (body as { image_digest?: string }).image_digest), [digest, digest]);
  await assert.rejects(
    sandboxes.create({ image: { id: "b".repeat(64), status: "building" } as never }),
    /is building, not ready/,
  );
});
