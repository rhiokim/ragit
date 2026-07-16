#!/usr/bin/env node

import { assertRagitRuntime } from "./core/runtime.js";

try {
  assertRagitRuntime();
  const { runMcpStdio } = await import("./mcp/startup.js");
  await runMcpStdio(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ragit-mcp] error: ${message}`);
  process.exitCode = 1;
}
