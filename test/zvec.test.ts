import { describe, expect, it } from "vitest";
import { formatZvecPlatformSupport, getZvecPlatformSupport, isZvecPlatformSupported, zvecPlatformUnsupportedMessage } from "../src/core/zvec.js";

describe("zvec platform support", () => {
  it("recognizes supported targets", () => {
    const support = getZvecPlatformSupport("darwin", "arm64");

    expect(support.supported).toBe(true);
    expect(support.current).toBe("darwin/arm64");
    expect(support.supportedTargets).toContain("linux/x64");
    expect(isZvecPlatformSupported("linux", "x64")).toBe(true);
  });

  it("formats unsupported targets with the supported matrix", () => {
    expect(isZvecPlatformSupported("win32", "x64")).toBe(false);
    expect(formatZvecPlatformSupport("win32", "x64")).toBe(
      "win32/x64 unsupported (supported: darwin/arm64, linux/arm64, linux/x64)",
    );
    expect(zvecPlatformUnsupportedMessage("win32", "x64")).toBe(
      "현재 플랫폼에서는 zvec를 지원하지 않습니다: win32/x64 unsupported (supported: darwin/arm64, linux/arm64, linux/x64)",
    );
  });
});
