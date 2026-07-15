import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/bootstrap.js";

describe("runtime diagnostics", () => {
  it("reports the Node floor and native target through doctor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-runtime-doctor-"));
    try {
      const result = await runDoctor(cwd);
      expect(result.checks.find((check) => check.name === "node.runtime")).toMatchObject({
        ok: true,
        detail: expect.stringContaining("minimum: >=22.14.0"),
      });
      expect(result.checks.find((check) => check.name === "zvec.platform")).toMatchObject({
        ok: true,
        detail: `${process.platform}/${process.arch}`,
      });
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });
});
