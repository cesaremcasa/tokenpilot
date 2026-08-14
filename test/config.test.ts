import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, selectMode } from "../src/config.js";

describe("mode selection", () => {
  it("uses observe by default and bypasses completely when requested", () => {
    expect(selectMode(DEFAULT_CONFIG, false)).toBe("observe");
    expect(selectMode(DEFAULT_CONFIG, true)).toBe("off");
  });

  it("randomizes balanced sessions deterministically when provided a random source", () => {
    const balanced = { ...DEFAULT_CONFIG, defaultMode: "balanced" as const, balancedSamplingRate: 0.5 };
    expect(selectMode(balanced, false, () => 0.2)).toBe("balanced");
    expect(selectMode(balanced, false, () => 0.9)).toBe("observe");
  });
});
