import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import {
  MINIMUM_NODE_VERSION,
  assertRagitRuntime,
  getNodeRuntimeSupport,
  getRagitRuntimeSupport,
  getZvecPlatformSupport,
  zvecPlatformUnsupportedMessage,
} from "../src/core/runtime.js";

describe("runtime support contract", () => {
  it("accepts the Node floor and Node 24 while rejecting older runtimes", () => {
    expect(MINIMUM_NODE_VERSION).toBe("22.14.0");
    expect(packageJson.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
    expect(packageJson.optionalDependencies["@zvec/zvec"]).toBe("0.2.1");
    expect(packageJson.dependencies).not.toHaveProperty("@zvec/zvec");
    expect(getNodeRuntimeSupport("22.14.0").supported).toBe(true);
    expect(getNodeRuntimeSupport("24.0.0").supported).toBe(true);
    expect(getNodeRuntimeSupport("22.13.1").supported).toBe(false);
    expect(getNodeRuntimeSupport("20.19.0").supported).toBe(false);
  });

  it("accepts only the production-supported zvec target matrix", () => {
    expect(getZvecPlatformSupport("darwin", "arm64").supported).toBe(true);
    expect(getZvecPlatformSupport("linux", "arm64").supported).toBe(true);
    expect(getZvecPlatformSupport("linux", "x64").supported).toBe(false);
    expect(getZvecPlatformSupport("darwin", "x64").supported).toBe(false);
    expect(getZvecPlatformSupport("win32", "x64").supported).toBe(false);
  });

  it("combines Node and native target support into one diagnostic contract", () => {
    expect(getRagitRuntimeSupport("24.0.0", "linux", "arm64")).toMatchObject({ supported: true });
    expect(getRagitRuntimeSupport("22.13.1", "linux", "arm64")).toMatchObject({ supported: false });
    expect(getRagitRuntimeSupport("24.0.0", "linux", "x64")).toMatchObject({ supported: false });
    expect(getRagitRuntimeSupport("24.0.0", "win32", "x64")).toMatchObject({ supported: false });

    expect(() => assertRagitRuntime("22.13.1", "linux", "arm64")).toThrow(
      "지원되지 않는 Node.js 런타임입니다: 22.13.1 (필수: >=22.14.0)",
    );
    expect(() => assertRagitRuntime("24.0.0", "linux", "x64")).toThrow(
      zvecPlatformUnsupportedMessage("linux", "x64"),
    );
    expect(() => assertRagitRuntime("24.0.0", "win32", "x64")).toThrow(
      zvecPlatformUnsupportedMessage("win32", "x64"),
    );
  });
});
