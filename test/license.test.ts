import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("license alignment", () => {
  it("keeps the published package metadata on Apache-2.0", async () => {
    const packageJsonPath = path.join(rootDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      license?: string;
    };

    expect(packageJson.license).toBe("Apache-2.0");
  });

  it("keeps the root LICENSE file on Apache License 2.0", async () => {
    const licensePath = path.join(rootDir, "LICENSE");
    const license = await readFile(licensePath, "utf8");

    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("http://www.apache.org/licenses/LICENSE-2.0");
  });
});
