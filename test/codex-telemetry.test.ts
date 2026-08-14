import { describe, expect, it } from "vitest";
import { CodexExecTokenParser, isCodexExec } from "../src/telemetry/codex.js";

describe("Codex non-interactive token total", () => {
  it("keeps only the provider-published numeric total across stream chunks", () => {
    const parser = new CodexExecTokenParser();
    parser.accept("user\nprivate response\ntokens u");
    parser.accept("sed\n7,6");
    parser.accept("75\n");
    expect(parser.finish()).toBe(7675);
  });

  it("rejects unlabelled or malformed output and leaves interactive Codex untouched", () => {
    const parser = new CodexExecTokenParser();
    parser.accept("tokens used\nnot a number\n7,675\n");
    expect(parser.finish()).toBeUndefined();
    expect(isCodexExec(["exec", "prompt"])).toBe(true);
    expect(isCodexExec(["--config", "x=1"])).toBe(false);
  });
});
