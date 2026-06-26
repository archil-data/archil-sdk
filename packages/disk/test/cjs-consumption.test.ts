// Guards the CJS `require("disk")` path. The SDK ships dual ESM/CJS builds; the
// CJS build goes through bundler-generated Node interop, where a dependency's
// `__esModule` marker can nest its default export under `.default`.
// openapi-fetch is exactly such a dependency, so without an interop shim in
// client.ts, `require("disk")` throws
// "(0 , import_openapi_fetch.default) is not a function" the moment you
// construct an Archil client.
//
// This builds the library entry to CJS with tsdown, then requires the output
// and constructs a client — exercising the real createApiClient →
// openapi-fetch factory path.

import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { build } from "tsdown";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(pkgRoot, "src", "index.ts");
let buildSeq = 0;

test("require()-ing the CJS build constructs a working client", async () => {
  // Emit inside the package so require() resolves externalized deps from the
  // package's own node_modules — the same place dist/index.cjs would.
  const outDir = path.join(pkgRoot, `.cjs-consumption-${process.pid}-${buildSeq++}`);
  await build({
    cwd: pkgRoot,
    entry: [path.relative(pkgRoot, ENTRY)],
    format: "cjs",
    dts: false,
    outDir,
    fixedExtension: false,
    logLevel: "silent",
    report: false,
    define: { __SDK_VERSION__: JSON.stringify("0-test") },
  });

  try {
    const require = createRequire(import.meta.url);
    const sdk = require(path.join(outDir, "index.cjs"));

    assert.equal(typeof sdk.Archil, "function");
    // Construction calls createApiClient → the openapi-fetch factory. Before the
    // interop fix this threw "default is not a function" right here.
    const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
    assert.equal(typeof archil.disks.list, "function");
    assert.equal(typeof archil.tokens.list, "function");
  } finally {
    await fs.rm(outDir, { force: true, recursive: true });
  }
});
