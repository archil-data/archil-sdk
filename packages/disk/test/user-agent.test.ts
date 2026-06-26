// Verifies the SDK identifies itself to the control plane with an
// `archil-js/<version>` User-Agent — distinct from the Python SDK's
// `archil-python/...` — and that the version mirrored in src/version.ts stays
// in lockstep with package.json.
//
// Like the CJS-consumption test, this builds the real library entry with
// tsdown and exercises the actual createApiClient -> openapi-fetch path,
// capturing the outbound request by stubbing global fetch.

import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { build } from "tsdown";

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
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    captured = headers.get("user-agent");
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const archil = new sdk.Archil({ apiKey: "key-test", region: "aws-us-east-1" });
    await archil.tokens.list();
    assert.equal(captured, `archil-js/${pkg.version}`);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});
