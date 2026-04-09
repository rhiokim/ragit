import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "skills", "use-ragit", "scripts", "resolve-ragit-runtime.mjs");

const tempDirs: string[] = [];

const writeExecutable = (filePath: string, body: string): void => {
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
};

const runResolver = (cwd: string, envPath: string): Record<string, unknown> =>
  JSON.parse(
    execFileSync(process.execPath, [SCRIPT_PATH, "--cwd", cwd], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: envPath,
      },
    }),
  ) as Record<string, unknown>;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("use-ragit runtime resolver", () => {
  it("prefers ragit on PATH when available", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-skill-path-"));
    tempDirs.push(temp);
    const binDir = path.join(temp, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(
      path.join(binDir, "ragit"),
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo 'ragit 9.9.9'\n  exit 0\nfi\nexit 1\n",
    );

    const result = runResolver(temp, `${binDir}:${process.env.PATH ?? ""}`);

    expect(result.available).toBe(true);
    expect(result.runner).toBe("ragit");
    expect(result.argv).toEqual(["ragit"]);
    expect(result.version).toBe("9.9.9");
  });

  it("uses pnpm exec when pnpm is the repository package manager and local ragit resolves", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-skill-pnpm-"));
    tempDirs.push(temp);
    const binDir = path.join(temp, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(temp, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeExecutable(
      path.join(binDir, "pnpm"),
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo '10.0.0'\n  exit 0\nfi\nif [ \"$1\" = \"exec\" ] && [ \"$2\" = \"ragit\" ] && [ \"$3\" = \"--version\" ]; then\n  echo '1.2.3'\n  exit 0\nfi\nexit 1\n",
    );

    const result = runResolver(temp, binDir);

    expect(result.available).toBe(true);
    expect(result.runner).toBe("pnpm-exec");
    expect(result.argv).toEqual(["pnpm", "exec", "ragit"]);
    expect(result.version).toBe("1.2.3");
    expect(result.packageManager).toBe("pnpm");
  });

  it("falls back to npx when no direct runtime is available", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-skill-npx-"));
    tempDirs.push(temp);
    const binDir = path.join(temp, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "npx"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo '10.0.0'\n  exit 0\nfi\nexit 1\n");

    const result = runResolver(temp, binDir);

    expect(result.available).toBe(true);
    expect(result.runner).toBe("npx");
    expect(result.argv).toEqual(["npx", "ragit"]);
    expect(result.version).toBeNull();
    expect(result.reason).toContain("network");
  });

  it("returns install guidance when no supported runtime exists", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-skill-missing-"));
    tempDirs.push(temp);
    mkdirSync(path.join(temp, "bin"), { recursive: true });

    const result = runResolver(temp, path.join(temp, "bin"));

    expect(result.available).toBe(false);
    expect(result.runner).toBeNull();
    expect(result.installGuidance).toBeTruthy();
    expect((result.installGuidance as { commands: string[] }).commands[0]).toContain("npm install -g ragit");
  });
});
