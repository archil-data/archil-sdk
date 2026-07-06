import assert from "node:assert/strict";
import { test } from "vitest";
import { Archil } from "../src/index.js";

test("exec forwards multi-disk mount options", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown;
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.host === "cp.test" && url.pathname === "/api/exec") {
      capturedBody = JSON.parse(await req.text());
      return json({
        success: true,
        data: {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
        },
      });
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

    await archil.exec({
      command: "npm test",
      disks: {
        data: {
          disk: "dsk-1",
          checkoutPaths: ["src", "tmp/cache"],
          queueMs: 250,
          conditional: true,
        },
      },
    });

    assert.deepEqual(capturedBody, {
      command: "npm test",
      disks: {
        data: {
          disk: "dsk-1",
          readOnly: false,
          conditional: true,
          queueMs: 250,
          checkoutPaths: ["src", "tmp/cache"],
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
