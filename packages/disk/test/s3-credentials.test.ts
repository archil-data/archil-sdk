// Unit tests for the disk's S3 credential helpers, which wrap addUser and
// removeUser for the "s3" user type.

import { test } from "vitest";
import assert from "node:assert/strict";
import { Disk } from "../src/disk.js";
import type { ApiClient } from "../src/client.js";
import type { DiskResponse } from "../src/types.js";

const diskData = {
  id: "dsk-0123456789abcdef",
  name: "s3-credentials-test",
  organization: "org",
  status: "available",
  provider: "aws",
  region: "aws-us-east-1",
  createdAt: "2026-01-01T00:00:00Z",
} as DiskResponse;

interface RecordedCall {
  method: "POST" | "DELETE";
  path: string;
  params?: unknown;
  body?: unknown;
}

function disk(body: unknown) {
  const calls: RecordedCall[] = [];
  const handle = async (method: "POST" | "DELETE", path: string, opts?: { params?: unknown; body?: unknown }) => {
    calls.push({ method, path, params: opts?.params, body: opts?.body });
    return { data: body, response: new Response(null, { status: 200 }) };
  };
  const client = {
    POST: (path: string, opts?: { body?: unknown }) => handle("POST", path, opts),
    DELETE: (path: string, opts?: { params?: unknown }) => handle("DELETE", path, opts),
  } as unknown as ApiClient;
  return { disk: new Disk(diskData, client, "aws-us-east-1"), calls };
}

test("createS3Credentials() adds an s3 user and returns its keys", async () => {
  const { disk: d, calls } = disk({
    success: true,
    data: { type: "s3", identifier: "AKIA1234", s3AccessKeyId: "AKIA1234", s3SecretKey: "secret", readOnly: true },
  });

  const creds = await d.createS3Credentials({ nickname: "uploads", ttl: "1h", readOnly: true });

  assert.equal(creds.s3AccessKeyId, "AKIA1234");
  assert.equal(creds.s3SecretKey, "secret");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/disks/{id}/users");
  assert.deepEqual(calls[0].body, { nickname: "uploads", ttl: "1h", readOnly: true, type: "s3" });
});

test("createS3Credentials() throws when the server returns no secret", async () => {
  const { disk: d } = disk({ success: true, data: { type: "s3", identifier: "AKIA1234", s3AccessKeyId: "AKIA1234" } });

  await assert.rejects(d.createS3Credentials(), /did not return generated S3 credentials/);
});

test("removeS3Credentials() deletes the s3 user by access key ID", async () => {
  const { disk: d, calls } = disk({ success: true, data: { message: "User removed successfully" } });

  await d.removeS3Credentials("AKIA1234");

  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].path, "/api/disks/{id}/users/{userType}");
  assert.deepEqual(calls[0].params, {
    path: { id: "dsk-0123456789abcdef", userType: "s3" },
    query: { identifier: "AKIA1234" },
  });
});
