#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";

const SEMVER_RE = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

const parseArgs = (argv) => {
  const parsed = { cwd: process.cwd() };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--cwd requires a path");
      }
      parsed.cwd = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }

  return parsed;
};

const canRead = async (target) => {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const run = (command, args, cwd) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

const extractVersion = (text) => {
  const normalized = `${text ?? ""}`.trim();
  if (!normalized) return null;
  const match = normalized.match(SEMVER_RE);
  return match?.[0] ?? normalized.split(/\s+/)[0] ?? null;
};

const tryVersionCommand = (command, args, cwd) => {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    return null;
  }
  return extractVersion(`${result.stdout}\n${result.stderr}`);
};

const resolveGitRoot = (cwd) => {
  const result = run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.status !== 0) {
    return cwd;
  }
  const output = result.stdout.trim();
  return output ? path.resolve(output) : cwd;
};

const readPackageManagerField = async (startDir, stopDir) => {
  let current = startDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (await canRead(packageJsonPath)) {
      try {
        const parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
        const value = typeof parsed.packageManager === "string" ? parsed.packageManager.trim() : "";
        if (value) {
          return value;
        }
      } catch {
        // Ignore malformed package.json here; runtime detection can continue using lockfiles.
      }
    }

    if (current === stopDir) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
};

const detectPackageManager = async (cwd, repoRoot) => {
  const packageManagerField = await readPackageManagerField(cwd, repoRoot);
  const normalizedField = packageManagerField?.split("@")[0] ?? null;

  if (normalizedField === "pnpm" || normalizedField === "bun" || normalizedField === "npm") {
    return normalizedField;
  }

  if (await canRead(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if ((await canRead(path.join(repoRoot, "bun.lockb"))) || (await canRead(path.join(repoRoot, "bun.lock")))) return "bun";
  if ((await canRead(path.join(repoRoot, "package-lock.json"))) || (await canRead(path.join(repoRoot, "npm-shrinkwrap.json")))) return "npm";

  return "unknown";
};

const commandAvailable = (command, cwd) => run(command, ["--version"], cwd).status === 0;

const installGuidance = (packageManager) => {
  const commands = ["npm install -g ragit", "pnpm add -g ragit", "bun add -g ragit"];
  return {
    commands,
    packageManagerHint:
      packageManager === "pnpm"
        ? "Prefer a local or global pnpm installation if this repository already standardizes on pnpm."
        : packageManager === "bun"
          ? "Prefer a local or global Bun installation if this repository already standardizes on Bun."
          : "Use any supported global installation path, or add ragit as a project dependency.",
  };
};

const main = async () => {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const cwd = parsed.cwd;
  const repoRoot = resolveGitRoot(cwd);
  const packageManager = await detectPackageManager(cwd, repoRoot);

  const directVersion = tryVersionCommand("ragit", ["--version"], cwd);
  if (directVersion) {
    console.log(
      JSON.stringify(
        {
          available: true,
          runner: "ragit",
          argv: ["ragit"],
          version: directVersion,
          cwd,
          repoRoot,
          packageManager,
          reason: "found ragit on PATH",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (packageManager === "pnpm" && commandAvailable("pnpm", cwd)) {
    const pnpmVersion = tryVersionCommand("pnpm", ["exec", "ragit", "--version"], cwd);
    if (pnpmVersion) {
      console.log(
        JSON.stringify(
          {
            available: true,
            runner: "pnpm-exec",
            argv: ["pnpm", "exec", "ragit"],
            version: pnpmVersion,
            cwd,
            repoRoot,
            packageManager,
            reason: "resolved local ragit via pnpm exec",
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  if (packageManager === "bun" && (commandAvailable("bunx", cwd) || commandAvailable("bun", cwd))) {
    const argv = commandAvailable("bunx", cwd) ? ["bunx", "ragit"] : ["bun", "x", "ragit"];
    console.log(
      JSON.stringify(
        {
          available: true,
          runner: "bunx",
          argv,
          version: null,
          cwd,
          repoRoot,
          packageManager,
          reason: "bun environment detected; bunx fallback may fetch from the network if ragit is not installed locally",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (commandAvailable("npx", cwd)) {
    console.log(
      JSON.stringify(
        {
          available: true,
          runner: "npx",
          argv: ["npx", "ragit"],
          version: null,
          cwd,
          repoRoot,
          packageManager,
          reason: "npx fallback may fetch from the network if ragit is not installed locally",
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    JSON.stringify(
      {
        available: false,
        runner: null,
        argv: [],
        version: null,
        cwd,
        repoRoot,
        packageManager,
        reason: "ragit CLI is not available on PATH and no supported package-manager fallback was found",
        installGuidance: installGuidance(packageManager),
      },
      null,
      2,
    ),
  );
};

await main();
