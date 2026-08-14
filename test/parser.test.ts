import { describe, expect, it } from "vitest";
import { parseUsageLine } from "../src/adapters/parser.js";

describe("telemetry parsing", () => {
  it("extracts Kimi numeric counters without retaining text", () => {
    const parsed = parseUsageLine(JSON.stringify({
      type: "StatusUpdate",
      payload: {
        token_usage: { inputOther: 11, inputCacheRead: 29, inputCacheCreation: 4, output: 7 },
        content: "this must never leave the parser"
      }
    }));

    expect(parsed?.usage).toEqual({ inputNew: 11, inputCached: 29, cacheCreated: 4, output: 7 });
    expect(JSON.stringify(parsed)).not.toContain("this must never leave the parser");
  });

  it("recognises cache and reasoning counters from other CLI formats", () => {
    const parsed = parseUsageLine('{"usage":{"input_tokens":13,"cache_read_input_tokens":21,"cache_creation_input_tokens":8,"output_tokens":5,"reasoning_output_tokens":3}}');
    expect(parsed?.usage).toEqual({ inputNew: 13, inputCached: 21, cacheCreated: 8, output: 5, reasoning: 3 });
  });

  it("ignores invalid JSON", () => {
    expect(parseUsageLine("not json")).toBeUndefined();
  });
});
