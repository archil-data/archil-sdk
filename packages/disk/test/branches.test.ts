// Unit tests for disk branch operations. createBranch() sends one
// Idempotency-Key for every attempt, so a retry after a timeout gets back the
// branch the first attempt created instead of a 409.

import { test } from "vitest";
import assert from "node:assert/strict";
import { validate as isUuid } from "uuid";
import { Disk } from "../src/disk.js";
import { ArchilApiError } from "../src/errors.js";
import type { ApiClient } from "../src/client.js";
import type { Branch, DiskResponse } from "../src/types.js";

const diskData = {
  id: "dsk-0123456789abcdef",
  name: "branches-test",
  organization: "org",
  status: "available",
  provider: "aws",
  region: "aws-us-east-1",
  createdAt: "2026-01-01T00:00:00Z",
} as DiskResponse;

const branch: Branch = {
  root_filesystem_id: "dsk-0123456789abcdef",
  branch_name: "work",
  filesystem_id: "dsk-00000000000000aa",
  from_checkpoint_name: "cp1",
  from_checkpoint_filesystem_id: "dsk-0123456789abcdef",
  created_at: "2026-10-07T00:00:00Z",
};

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
  params?: { path?: Record<string, string>; header?: Record<string, string> };
  body?: unknown;
}

type CallOpts = Pick<RecordedCall, "params" | "body">;

function fakeClient(
  respond: (call: RecordedCall) => { status?: number; body: unknown },
): { client: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handle = async (method: "GET" | "POST", path: string, opts?: CallOpts) => {
    const call: RecordedCall = { method, path, params: opts?.params, body: opts?.body };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return status >= 400
      ? { error: body, response: new Response(null, { status }) }
      : { data: body, response: new Response(null, { status }) };
  };
  const client = {
    GET: (path: string, opts?: CallOpts) => handle("GET", path, opts),
    POST: (path: string, opts?: CallOpts) => handle("POST", path, opts),
  } as unknown as ApiClient;
  return { client, calls };
}

function disk(respond: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(respond);
  return { disk: new Disk(diskData, client, "aws-us-east-1"), calls };
}

test("createBranch() posts the spec's field names with a UUID Idempotency-Key", async () => {
  const { disk: d, calls } = disk(() => ({ status: 201, body: { success: true, data: branch } }));

  const result = await d.createBranch({ name: "work", fromCheckpoint: "cp1", fromBranch: "base" });

  assert.deepEqual(result, branch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/disks/{id}/branches");
  assert.deepEqual(calls[0].params?.path, { id: diskData.id });
  assert.deepEqual(calls[0].body, {
    branch_name: "work",
    from_checkpoint_name: "cp1",
    from_branch: "base",
  });
  assert.ok(isUuid(calls[0].params?.header?.["Idempotency-Key"] ?? ""));
});

test("createBranch() reuses the Idempotency-Key when it retries", async () => {
  let attempt = 0;
  const { disk: d, calls } = disk(() =>
    ++attempt === 1
      ? { status: 504, body: { success: false, error: "Request timed out" } }
      : { status: 201, body: { success: true, data: branch } },
  );

  assert.deepEqual(await d.createBranch({ name: "work", fromCheckpoint: "cp1" }), branch);

  assert.equal(calls.length, 2);
  const [first, second] = calls.map((c) => c.params?.header?.["Idempotency-Key"]);
  assert.ok(first);
  assert.equal(second, first);
});

test("createBranch() uses a fresh Idempotency-Key per call", async () => {
  const { disk: d, calls } = disk(() => ({ status: 201, body: { success: true, data: branch } }));

  await d.createBranch({ name: "a", fromCheckpoint: "cp1" });
  await d.createBranch({ name: "b", fromCheckpoint: "cp1" });

  assert.notEqual(
    calls[0].params?.header?.["Idempotency-Key"],
    calls[1].params?.header?.["Idempotency-Key"],
  );
});

test("createBranch() sends a caller-supplied Idempotency-Key on every attempt", async () => {
  const key = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  let attempt = 0;
  const { disk: d, calls } = disk(() =>
    ++attempt === 1
      ? { status: 504, body: { success: false, error: "Request timed out" } }
      : { status: 201, body: { success: true, data: branch } },
  );

  await d.createBranch({ name: "work", fromCheckpoint: "cp1", idempotencyKey: key });

  assert.deepEqual(
    calls.map((c) => c.params?.header?.["Idempotency-Key"]),
    [key, key],
  );
  assert.equal((calls[0].body as Record<string, unknown>).idempotencyKey, undefined);
});

test("createBranch() surfaces a 409 without retrying", async () => {
  const { disk: d, calls } = disk(() => ({
    status: 409,
    body: { success: false, error: 'Branch "work" already exists' },
  }));

  await assert.rejects(
    () => d.createBranch({ name: "work", fromCheckpoint: "cp1" }),
    (err: unknown) => {
      assert.ok(err instanceof ArchilApiError);
      assert.equal(err.status, 409);
      assert.match(err.message, /already exists/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("listBranches() unwraps the envelope", async () => {
  const { disk: d, calls } = disk(() => ({ body: { success: true, data: [branch] } }));

  assert.deepEqual(await d.listBranches(), [branch]);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/disks/{id}/branches");
  assert.deepEqual(calls[0].params?.path, { id: diskData.id });
});

test("getBranch() addresses the branch by name", async () => {
  const { disk: d, calls } = disk(() => ({ body: { success: true, data: branch } }));

  assert.deepEqual(await d.getBranch("work"), branch);
  assert.equal(calls[0].path, "/api/disks/{id}/branches/{name}");
  assert.deepEqual(calls[0].params?.path, { id: diskData.id, name: "work" });
});

test("getBranch() surfaces a 404 as ArchilApiError", async () => {
  const { disk: d } = disk(() => ({
    status: 404,
    body: { success: false, error: 'Branch "missing" not found' },
  }));

  await assert.rejects(() => d.getBranch("missing"), (err: unknown) => {
    assert.ok(err instanceof ArchilApiError);
    assert.equal(err.status, 404);
    return true;
  });
});
