import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/native.ts"],
  format: ["cjs", "esm"],
  dts: true,
});
