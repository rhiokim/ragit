import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli-entry.ts", index: "src/index.ts", mcp: "src/mcp-entry.ts" },
  format: ["esm"],
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: true,
  fixedExtension: false,
});
