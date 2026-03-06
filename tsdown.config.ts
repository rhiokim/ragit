import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: true,
  fixedExtension: false,
});
