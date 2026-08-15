import { describe, expect, it } from "vitest";
import { GrokJsonUsageParser, isGrokJsonSingle } from "../src/telemetry/grok.js";

describe("Grok JSON usage telemetry", () => {
  it("retains only the numeric top-level usage object", () => {
    const parser = new GrokJsonUsageParser();
    parser.accept('{\n  "text": "private output",\n  "thought": "private reasoning",\n  "usage": {\n    "input_tokens": 7');
    parser.accept('542,\n    "cache_read_input_tokens": 11520,\n    "cache_creation_input_tokens": 0,\n    "output_tokens": 57,\n    "reasoning_tokens": 41,\n    "total_tokens": 19119\n  },\n  "modelUsage": {\n    "private": {\n      "inputTokens": 999\n    }\n  }\n}\n');
    expect(parser.finish()).toEqual({ inputNew: 7542, inputCached: 11520, cacheCreated: 0, output: 57, reasoning: 41, reportedTotal: 19119, reportedTotalIncludesCachedInput: true });
  });

  it("observes only explicit JSON single-turn invocations", () => {
    expect(isGrokJsonSingle(["--output-format", "json", "--single", "test"])).toBe(true);
    expect(isGrokJsonSingle(["--output-format=json", "-p", "test"])).toBe(true);
    expect(isGrokJsonSingle(["--single", "test"])).toBe(false);
    expect(isGrokJsonSingle(["--output-format", "json", "test"])).toBe(false);
  });
});
