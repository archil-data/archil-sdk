import assert from "node:assert/strict";
import { test } from "vitest";
import { Archil } from "../src/index.js";
import { apiKeyAuthorization } from "../src/client.js";
import { json, startOrigin } from "./helpers/origin.js";

test("apiKeyAuthorization sends exactly one key- prefix after Bearer", () => {
  assert.equal(apiKeyAuthorization("key-abc123"), "Bearer key-abc123");
  assert.equal(apiKeyAuthorization("abc123"), "Bearer key-abc123");
});

for (const apiKey of ["key-abc123", "abc123"]) {
  test(`control-plane and S3 requests send Bearer key-<key> when configured as ${apiKey}`, async () => {
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
    const s3 = await startOrigin(() => ({ status: 200, headers: { etag: '"ok"' } }));
    try {
      const archil = new Archil({ apiKey, region: "aws-us-east-1", baseUrl: control.url, s3BaseUrl: s3.url });
      const [disk] = await archil.disks.list();
      await disk.putObject("hello.txt", "hi");

      assert.deepEqual(control.requests.map((r) => r.headers.get("authorization")), ["Bearer key-abc123"]);
      assert.deepEqual(s3.requests.map((r) => r.headers.get("authorization")), ["Bearer key-abc123"]);
    } finally {
      await Promise.all([control.close(), s3.close()]);
    }
  });
}
