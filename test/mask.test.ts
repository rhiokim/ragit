import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src/core/mask.js";

describe("secret masking", () => {
  it("masks known token patterns", () => {
    const sample = "OPENAI=sk-abcdefghijklmnopqrstuvwxyz123456 github=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12";
    const result = maskSecrets(sample);
    expect(result.maskedCount).toBeGreaterThanOrEqual(2);
    expect(result.text.includes("sk-abc")).toBe(true);
    expect(result.text.includes("***")).toBe(true);
  });

  it("masks key-value secrets", () => {
    const sample = 'api_key: "super-secret-value"';
    const result = maskSecrets(sample);
    expect(result.maskedCount).toBe(1);
    expect(result.text).toContain("api_key");
    expect(result.text).toContain("***");
  });

  it("masks bearer and jwt style tokens", () => {
    const sample = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.segment";
    const result = maskSecrets(sample);
    expect(result.maskedCount).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain("Bearer eyJh***");
    expect(result.text).not.toContain(".payload.segment");
  });

  it("masks URI credentials and secret query parameters", () => {
    const sample = "https://alice:supersecret@example.com/callback?access_token=abcdef1234567890";
    const result = maskSecrets(sample);
    expect(result.maskedCount).toBe(2);
    expect(result.text).toContain("https://alice:***@example.com");
    expect(result.text).toContain("access_token=abcd***");
  });
});
