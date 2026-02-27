import { describe, expect, it } from "vitest";
import { calculateHybridScore } from "../src/core/retrieval.js";

describe("hybrid scoring", () => {
  it("is deterministic and bounded by weighted inputs", () => {
    const scoreA = calculateHybridScore(0.8, 0.2, 0.7);
    const scoreB = calculateHybridScore(0.8, 0.2, 0.7);
    expect(scoreA).toBeCloseTo(scoreB, 12);
    expect(scoreA).toBeCloseTo(0.62, 5);
  });
});
