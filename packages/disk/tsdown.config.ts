import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// Inject the package version as a compile-time constant so the SDK's User-Agent
// reflects the published version. CI runs `npm version` (which rewrites
// package.json) before `npm run build`, so reading it here picks up the release
// version without resolving package.json at runtime across ESM/CJS/browser
// targets.
const define = { __SDK_VERSION__: JSON.stringify(version) };
const entries = {
  index: "src/index.ts",
  "internal/tools": "src/internal/tools.ts"
};

export default defineConfig({
  entry: entries,
  format: {
    cjs: {},
    esm: {
      entry: {
        ...entries,
        cli: "bin/cli.ts",
      },
    },
  },
  dts: {
    entry: Object.values(entries),
  },
  define,
});
