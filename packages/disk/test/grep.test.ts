import assert from "node:assert/strict";
import { test } from "vitest";
import { Archil } from "../src/index.js";
import { json, startOrigin } from "./helpers/origin.js";

const diskWire = {
  id: "dsk-1", name: "d1", organization: "org", status: "available",
  provider: "aws", region: "aws-us-east-1", createdAt: "2026-01-01T00:00:00Z",
};

const grepResult = {
  success: true,
  data: {
    matches: [{ file: "a.txt", line: 3, endLine: 4, text: "x\ny" }],
    groups: [{ file: "a.txt", lines: [{ line: 2, text: "w", match: false }, { line: 3, text: "x", match: true }] }],
    stoppedReason: "completed",
    filesScanned: 1,
    containersDispatched: 1,
    computeSecondsUsed: 0,
    durationMs: 1,
    listingMs: 0,
    grepMs: 1,
  },
};

test("grep sends ripgrep options and returns endLine and groups", async () => {
  const control = await startOrigin((request) => {
    if (request.url.pathname === "/api/disks/dsk-1") return json({ success: true, data: diskWire });
    if (request.url.pathname === "/api/disks/dsk-1/grep") return json(grepResult);
    return json({ success: false, error: `unexpected request: ${request.method} ${request.url}` }, 500);
  });

  try {
    const archil = new Archil({ apiKey: "key-test", region: "aws-us-east-1", baseUrl: control.url, s3BaseUrl: "http://s3.test" });
    const disk = await archil.disks.get("dsk-1");

    const res = await disk.grep({
      directory: "src",
      pattern: "x\ny",
      ignoreCase: true,
      multiline: true,
      globs: ["*.ts", "!*.test.ts"],
      types: ["ts"],
      typesNot: ["md"],
      contextBefore: 1,
      contextAfter: 2,
    });
    assert.deepEqual(res.matches, grepResult.data.matches);
    assert.deepEqual(res.groups, grepResult.data.groups);

    await disk.grep({ directory: "src", pattern: "x" });

    const bodies = control.requests
      .filter((request) => request.url.pathname === "/api/disks/dsk-1/grep")
      .map((request) => JSON.parse(request.body));
    assert.deepEqual(bodies, [
      {
        directory: "src",
        pattern: "x\ny",
        recursive: false,
        maxDurationSeconds: 30,
        concurrency: 50,
        maxResults: 1000,
        ignoreCase: true,
        multiline: true,
        globs: ["*.ts", "!*.test.ts"],
        types: ["ts"],
        typesNot: ["md"],
        contextBefore: 1,
        contextAfter: 2,
      },
      {
        directory: "src",
        pattern: "x",
        recursive: false,
        maxDurationSeconds: 30,
        concurrency: 50,
        maxResults: 1000,
        contextBefore: 0,
        contextAfter: 0,
      },
    ]);
  } finally {
    await control.close();
  }
});
