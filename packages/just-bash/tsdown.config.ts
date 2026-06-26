import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: {
    cjs: {},
    esm: {
      entry: {
        index: "src/index.ts",
        shell: "bin/shell.ts",
      },
    },
  },
  dts: {
    entry: "src/index.ts",
  },
});
