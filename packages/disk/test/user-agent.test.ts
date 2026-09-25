// Verifies the SDK identifies itself to the control plane with an
// `archil-js/<version>` User-Agent — distinct from the Python SDK's
// `archil-python/...` — and that the version mirrored in src/version.ts stays
// in lockstep with package.json.
//
// Like the CJS-consumption test, this builds the real library entry with
// tsdown and exercises the actual createApiClient -> openapi-fetch -> Undici
// path against a local origin that records the outbound request.

import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { build } from "tsdown";
import { json, startOrigin } from "./helpers/origin.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = require(path.join(pkgRoot, "package.json"));
let buildSeq = 0;

// Mirror tsdown.config.ts: inject the package version as a compile-time constant
// so the bundle exercises the real version path rather than the dev fallback.
async function loadSdk() {
  const outDir = path.join(pkgRoot, `.user-agent-${process.pid}-${buildSeq++}`);
  await build({
    cwd: pkgRoot,
    entry: ["src/index.ts"],
    format: "cjs",
    dts: false,
    outDir,
    fixedExtension: false,
    logLevel: "silent",
    report: false,
    define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
  });
  return {
    sdk: require(path.join(outDir, "index.cjs")),
    cleanup: () => fs.rm(outDir, { force: true, recursive: true }),
  };
}

test("build-time injection sets VERSION from package.json", async () => {
  const { sdk, cleanup } = await loadSdk();
  try {
    assert.equal(sdk.VERSION, pkg.version);
    assert.equal(sdk.USER_AGENT, `archil-js/${pkg.version}`);
  } finally {
    await cleanup();
  }
});

test("control-plane requests carry the archil-js User-Agent", async () => {
  const { sdk, cleanup } = await loadSdk();
  const control = await startOrigin(() => json({ success: true, data: [] }));
  try {
    const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1", baseUrl: control.url });
    await archil.tokens.list();
    assert.equal(control.requests[0]?.headers.get("user-agent"), `archil-js/${pkg.version}`);
  } finally {
    await control.close();
    await cleanup();
  }
});
