import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";
import { RAGIT_VERSION } from "../src/core/version.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("version alignment", () => {
  it("keeps runtime exports aligned with package.json", async () => {
    const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")) as {
      version: string;
    };

    expect(version).toBe(packageJson.version);
    expect(RAGIT_VERSION).toBe(packageJson.version);
  });
});
