import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createApiClient } from "../src/client.js";
import { Archil, ArchilApiError, Disk } from "../src/index.js";
import type { CreateApiTokenRequest, CreateDiskRequest, Delegation, DiskResponse } from "../src/types.js";
import { json, startOrigin, type CannedResponse } from "./helpers/origin.js";

const diskWire = {
  id: "dsk-1", name: "d1", organization: "org", status: "available",
  provider: "aws", region: "aws-us-east-1", createdAt: "2026-01-01T00:00:00Z",
};
const unavailable = json({ success: false, error: "unavailable" }, 503);

afterEach(() => vi.restoreAllMocks());

function requestLines(requests: { method: string; url: URL }[]): string[] {
  return requests.map((request) => `${request.method} ${request.url.pathname}`);
}

test("reads and idempotent writes retry a transient failure once the backoff elapses", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const responses: CannedResponse[] = [
    unavailable, json({ success: true, data: diskWire }),
    { destroy: true }, json({ success: true, data: { matches: [], stoppedReason: "completed" } }),
    unavailable, json({ success: true, data: { allowedIps: ["10.0.0.1"] } }),
  ];
  const control = await startOrigin(() => responses.shift() ?? json({ success: false, error: "unexpected request" }, 500));
  try {
    const archil = new Archil({ apiKey: "key-test", region: "aws-us-east-1", baseUrl: control.url, s3BaseUrl: "http://s3.test" });
    const disk = await archil.disks.get("dsk-1");
    assert.equal(disk.id, "dsk-1");
    await disk.grep({ directory: "/", pattern: "needle" });
    assert.deepEqual(await disk.setAllowedIPs(["10.0.0.1"]), ["10.0.0.1"]);
    assert.deepEqual(requestLines(control.requests), [
      "GET /api/disks/dsk-1",
      "GET /api/disks/dsk-1",
      "POST /api/disks/dsk-1/grep",
      "POST /api/disks/dsk-1/grep",
      "PUT /api/disks/dsk-1/allowed-ips",
      "PUT /api/disks/dsk-1/allowed-ips",
    ]);
  } finally {
    await control.close();
  }
});

test("creations, execs, and deletes surface a transient failure without a second request", async () => {
  const control = await startOrigin(() => unavailable);
  try {
    const archil = new Archil({ apiKey: "key-test", region: "aws-us-east-1", baseUrl: control.url, s3BaseUrl: "http://s3.test" });
    const apiClient = createApiClient({ apiKey: "key-test", region: "aws-us-east-1", baseUrl: control.url });
    const disk = new Disk(diskWire as unknown as DiskResponse, apiClient, "aws-us-east-1", "http://s3.test");
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["POST /api/disks", () => archil.disks.create({ name: "d2" } as unknown as CreateDiskRequest)],
      ["POST /api/disks/dsk-1/exec", () => archil.disks.exec("dsk-1", "true")],
      ["POST /api/exec", () => archil.exec({ disks: { data: "dsk-1" }, command: "true" })],
      ["POST /api/tokens", () => archil.tokens.create({ name: "t" } as unknown as CreateApiTokenRequest)],
      ["DELETE /api/tokens/tok-1", () => archil.tokens.delete("tok-1")],
      ["POST /api/disks/dsk-1/users", () => disk.createToken("nick")],
      ["DELETE /api/disks/dsk-1/users/token", () => disk.removeUser("token", "tok-1")],
      ["POST /api/disks/dsk-1/revoke-delegation", () => disk.revokeDelegation({ clientId: "c", inodeId: 1 } as unknown as Pick<Delegation, "clientId" | "inodeId">)],
      ["DELETE /api/disks/dsk-1", () => disk.delete()],
    ];
    for (const [expected, attempt] of attempts) {
      const before = control.requests.length;
      await assert.rejects(attempt(), (error: unknown) => error instanceof ArchilApiError && error.status === 503);
      assert.deepEqual(requestLines(control.requests.slice(before)), [expected]);
    }
  } finally {
    await control.close();
  }
});
