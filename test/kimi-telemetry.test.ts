import { describe, expect, it } from "vitest";
import { KIMI_BALANCED_DISABLED_TOOLS, KimiUsageAccumulator, kimiHeadlessRequest, supportsKimiWebBridgeVersion } from "../src/telemetry/kimi.js";

describe("Kimi documented local session channel", () => {
  it("accepts only the bounded text print surface", () => {
    expect(kimiHeadlessRequest(["-p", "private-task"])).toEqual({ prompt: "private-task" });
    expect(kimiHeadlessRequest(["--prompt=private-task", "--model", "kimi-for-coding", "--output-format=text"])).toEqual({
      prompt: "private-task",
      model: "kimi-for-coding"
    });
    expect(kimiHeadlessRequest(["-p", "private-task", "--output-format", "stream-json"])).toBeUndefined();
    expect(kimiHeadlessRequest(["-p", "private-task", "--resume", "provider-session"])).toBeUndefined();
  });

  it("uses only the audited Kimi 0.36 protocol family", () => {
    expect(supportsKimiWebBridgeVersion("0.36.1")).toBe(true);
    expect(supportsKimiWebBridgeVersion("0.36.9")).toBe(true);
    expect(supportsKimiWebBridgeVersion("0.36.0")).toBe(false);
    expect(supportsKimiWebBridgeVersion("0.37.0")).toBe(false);
    expect(supportsKimiWebBridgeVersion(undefined)).toBe(false);
  });

  it("keeps the local repository primitives while removing optional tool surfaces", () => {
    expect(KIMI_BALANCED_DISABLED_TOOLS).toContain("WebSearch");
    expect(KIMI_BALANCED_DISABLED_TOOLS).toContain("Agent");
    for (const core of ["Bash", "Edit", "Read", "Write", "Grep", "Glob"]) {
      expect(KIMI_BALANCED_DISABLED_TOOLS).not.toContain(core as never);
    }
  });

  it("sums correlated per-step counters and keeps cache categories separate", () => {
    const accumulator = new KimiUsageAccumulator();
    accumulator.accept({ type: "turn.step.completed", payload: { usage: { inputOther: 40, inputCacheRead: 90, inputCacheCreation: 3, output: 8 } } });
    accumulator.accept({ type: "turn.step.retrying", payload: {} });
    accumulator.accept({ type: "turn.step.completed", payload: { usage: { inputOther: 10, inputCacheRead: 20, inputCacheCreation: 0, output: 2 } } });
    accumulator.accept({ type: "compaction.completed", payload: {} });
    expect(accumulator.finish()).toEqual({
      inputNew: 50,
      inputCached: 110,
      cacheCreated: 3,
      output: 10,
      modelCalls: 2,
      retries: 1,
      compactions: 1
    });
  });

  it("falls back to a correlated status total without double-counting it", () => {
    const accumulator = new KimiUsageAccumulator();
    accumulator.accept({
      type: "agent.status.updated",
      payload: { usage: { total: { inputOther: 12, inputCacheRead: 34, inputCacheCreation: 5, output: 6 } } }
    });
    expect(accumulator.finish()).toMatchObject({ inputNew: 12, inputCached: 34, cacheCreated: 5, output: 6, modelCalls: 1 });
  });
});
