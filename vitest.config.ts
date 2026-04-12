import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tools/narrative-tui/test/**"],
    fileParallelism: false,
  },
});
