import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "vitest";
import * as disk from "disk";
import * as archil from "../src/index.js";

const require = createRequire(import.meta.url);

function assertSameExports(alias: Record<string, unknown>, canonical: Record<string, unknown>) {
  assert.deepEqual(Object.keys(alias).sort(), Object.keys(canonical).sort());
  for (const name of Object.keys(canonical)) {
    assert.equal(alias[name], canonical[name], `export ${name} differs`);
  }
}

test("archil re-exports every symbol from disk", () => {
  assert.ok(Object.keys(disk).length > 0);
  assert.equal(typeof archil.Archil, "function");
  assertSameExports(archil, disk);
});

test("the built ESM entry re-exports disk's ESM entry", async () => {
  assertSameExports(await import("../dist/index.mjs"), disk);
});

test("the built CJS entry re-exports disk's CJS entry", () => {
  const canonical = require("disk");
  const alias = require("../dist/index.cjs");
  assertSameExports(alias, canonical);
  assert.equal(typeof new alias.Archil({ apiKey: "key-test", region: "aws-us-east-1" }).disks.list, "function");
});
