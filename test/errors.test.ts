import { describe, expect, it } from "vitest";
import {
  RAGIT_ERROR_DEFINITIONS,
  RagitOperationalError,
  isRagitOperationalError,
} from "../src/core/errors.js";

describe("RagitOperationalError", () => {
  it.each(Object.entries(RAGIT_ERROR_DEFINITIONS))(
    "keeps %s metadata stable",
    (code, definition) => {
      const cause = new Error("root cause");
      const error = new RagitOperationalError(
        code as keyof typeof RAGIT_ERROR_DEFINITIONS,
        "failure",
        {
          details: { ref: "abc123" },
          recovery: { command: "ragit status" },
          cause,
        },
      );

      expect(error).toMatchObject({
        name: "RagitOperationalError",
        message: "failure",
        code,
        category: definition.category,
        exitCode: definition.exitCode,
        retryable: definition.retryable,
        details: { ref: "abc123" },
        recovery: { command: "ragit status" },
        cause,
      });
      expect(error.toPayload()).toEqual({
        code,
        category: definition.category,
        message: "failure",
        retryable: definition.retryable,
        details: { ref: "abc123" },
        recovery: { command: "ragit status" },
      });
      expect(isRagitOperationalError(error)).toBe(true);
    },
  );

  it("does not classify unexpected errors as operational", () => {
    expect(isRagitOperationalError(new Error("unexpected"))).toBe(false);
    expect(isRagitOperationalError({ code: "SNAPSHOT_REF_INVALID" })).toBe(false);
  });
});
