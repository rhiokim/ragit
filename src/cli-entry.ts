#!/usr/bin/env node

import { assertRagitRuntime } from "./core/runtime.js";

try {
  assertRagitRuntime();
  await import("./cli.js");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ragit] 오류: ${message}`);
  process.exitCode = 1;
}
