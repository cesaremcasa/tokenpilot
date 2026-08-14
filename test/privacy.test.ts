import { describe, expect, it } from "vitest";
import { assertTelemetrySafe } from "../src/privacy.js";

describe("privacy guard", () => {
  it("allows the numeric-only data contract", () => {
    expect(() => assertTelemetrySafe({ provider: "codex", inputNew: 1, inputCached: 2, output: 3 })).not.toThrow();
  });

  it("rejects prompt and credential fields", () => {
    expect(() => assertTelemetrySafe({ prompt: "secret source code" })).toThrow(/prompt/i);
    expect(() => assertTelemetrySafe({ nested: { credential: "secret" } })).toThrow(/credential/i);
  });
});
