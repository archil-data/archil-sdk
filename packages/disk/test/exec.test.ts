import assert from "node:assert/strict";
import { test } from "vitest";
import { Archil } from "../src/index.js";
import { json, startOrigin } from "./helpers/origin.js";

const execResult = {
  success: true,
  data: {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
  },
};

test("exec forwards multi-disk mount options", async () => {
  const control = await startOrigin((request) => {
    if (request.url.pathname === "/api/exec") return json(execResult);
    return json({ success: false, error: `unexpected request: ${request.method} ${request.url}` }, 500);
  });

  try {
    const archil = new Archil({
      apiKey: "key-test",
      region: "aws-us-east-1",
      baseUrl: control.url,
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

    const exec = control.requests.find((request) => request.url.pathname === "/api/exec");
    assert.ok(exec, "expected a POST /api/exec request");
    assert.deepEqual(JSON.parse(exec.body), {
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
    await control.close();
  }
});

test("disks.exec runs against an id without fetching the disk", async () => {
  const control = await startOrigin(() => json({
    success: true,
    data: {
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      timing: { totalMs: 12, queueMs: 3, executeMs: 9 },
    },
  }));

  try {
    const archil = new Archil({
      apiKey: "key-test",
      region: "aws-us-east-1",
      baseUrl: control.url,
      s3BaseUrl: "http://s3.test",
    });

    const result = await archil.disks.exec("dsk-existing", "printf hello");

    assert.equal(result.stdout, "hello\n");
    assert.deepEqual(
      control.requests.map((request) => ({
        method: request.method,
        pathname: request.url.pathname,
        body: request.method === "POST" ? JSON.parse(request.body) : undefined,
      })),
      [
        {
          method: "POST",
          pathname: "/api/disks/dsk-existing/exec",
          body: { command: "printf hello" },
        },
      ],
    );
  } finally {
    await control.close();
  }
});
