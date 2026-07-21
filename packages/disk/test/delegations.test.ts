// Unit tests for disk delegation operations. A delegation has no ID of its
// own — it is identified by the (clientId, inodeId) pair — so
// listDelegations() returns those pairs and revokeDelegation() takes them.

import { test } from "vitest";
import assert from "node:assert/strict";
import { Disk } from "../src/disk.js";
import { ArchilApiError } from "../src/errors.js";
import type { ApiClient } from "../src/client.js";
import type { Delegation, DiskResponse } from "../src/types.js";

const diskData = {
  id: "dsk-0123456789abcdef",
  name: "delegations-test",
  organization: "org",
  status: "available",
  provider: "aws",
  region: "aws-us-east-1",
  createdAt: "2026-01-01T00:00:00Z",
} as DiskResponse;

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

function fakeClient(
  respond: (call: RecordedCall) => { status?: number; body: unknown },
): { client: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handle = async (method: "GET" | "POST", path: string, opts?: { body?: unknown }) => {
    const call: RecordedCall = { method, path, body: opts?.body };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return status >= 400
      ? { error: body, response: new Response(null, { status }) }
      : { data: body, response: new Response(null, { status }) };
  };
  const client = {
    GET: (path: string, opts?: { body?: unknown }) => handle("GET", path, opts),
    POST: (path: string, opts?: { body?: unknown }) => handle("POST", path, opts),
  } as unknown as ApiClient;
  return { client, calls };
}

function disk(respond: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(respond);
  return { disk: new Disk(diskData, client, "aws-us-east-1"), calls };
}

test("listDelegations() unwraps the envelope and returns entries", async () => {
  const delegations: Delegation[] = [
    { clientId: "42", inodeId: 7, path: "dir/file.txt", isPending: false, isOrphaned: false },
    { clientId: "99", inodeId: 10, isPending: true, isOrphaned: true },
  ];
  const { disk: d, calls } = disk(() => ({
    body: { success: true, data: { delegations } },
  }));

  const result = await d.listDelegations();
  assert.deepEqual(result, delegations);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/disks/{id}/delegations");
});

test("listDelegations() returns an empty list when the disk has none", async () => {
  const { disk: d } = disk(() => ({
    body: { success: true, data: { delegations: [] } },
  }));
  assert.deepEqual(await d.listDelegations(), []);
});

test("revokeDelegation() posts clientId as string and inodeId as number", async () => {
  const { disk: d, calls } = disk(() => ({
    body: { success: true, data: { message: "Delegation revoked" } },
  }));

  await d.revokeDelegation({ clientId: "42", inodeId: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/disks/{id}/revoke-delegation");
  assert.deepEqual(calls[0].body, { clientId: "42", inodeId: 7 });
});

test("revokeDelegation() accepts a full listDelegations entry and sends only the identifying pair", async () => {
  const { disk: d, calls } = disk(() => ({
    body: { success: true, data: { message: "Delegation revoked" } },
  }));

  const entry: Delegation = {
    clientId: "99",
    inodeId: 10,
    path: "stale/file.txt",
    isPending: false,
    isOrphaned: true,
  };
  await d.revokeDelegation(entry);
  assert.deepEqual(calls[0].body, { clientId: "99", inodeId: 10 });
});

test("API errors surface as ArchilApiError", async () => {
  const { disk: d } = disk(() => ({
    status: 404,
    body: { success: false, error: "Disk not found" },
  }));

  await assert.rejects(() => d.listDelegations(), (err: unknown) => {
    assert.ok(err instanceof ArchilApiError);
    assert.equal(err.message, "Disk not found");
    return true;
  });
  await assert.rejects(() => d.revokeDelegation({ clientId: "42", inodeId: 7 }), ArchilApiError);
});
