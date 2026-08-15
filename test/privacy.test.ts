import { describe, expect, it } from "vitest";
import { assertTelemetrySafe } from "../src/privacy.js";

describe("privacy guard", () => {
  it("allows the numeric-only data contract", () => {
    expect(() => assertTelemetrySafe({ provider: "codex", inputNew: 1, inputCached: 2, output: 3 })).not.toThrow();
  });

  it("rejects prompts, content, paths, commands, arguments, and credentials", () => {
    expect(() => assertTelemetrySafe({ prompt: "secret source code" })).toThrow(/prompt/i);
    expect(() => assertTelemetrySafe({ response: "secret" })).toThrow(/response/i);
    expect(() => assertTelemetrySafe({ path: "/private/work" })).toThrow(/path/i);
    expect(() => assertTelemetrySafe({ command: "private command" })).toThrow(/command/i);
    expect(() => assertTelemetrySafe({ args: ["private argument"] })).toThrow(/args/i);
    expect(() => assertTelemetrySafe({ nested: { credential: "secret" } })).toThrow(/credential/i);
  });
});
