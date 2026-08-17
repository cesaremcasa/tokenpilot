import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { GrokJsonUsageParser, isGrokJsonSingle, parseGrokOtlpMetricSamples, parseGrokOtlpMetrics, startGrokMetricsReceiver, supportsGrokExternalOtelVersion } from "../src/telemetry/grok.js";
import { cleanup, grokOtlpFixture, temporaryPaths } from "./helpers.js";

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

  it("parses documented content-free External OTEL v1 token counters", () => {
    const payload = grokOtlpFixture({ input: 46, cache_read: 34, output: 5, reasoning: 6 });
    expect(parseGrokOtlpMetrics(payload)).toEqual({ inputNew: 12, inputCached: 34, cacheCreated: 0, output: 5, reasoning: 6 });
    expect(parseGrokOtlpMetrics(grokOtlpFixture({ unknown: 999 }))).toBeUndefined();
    expect(parseGrokOtlpMetrics(grokOtlpFixture({ input: 12, cache_read: 34 }))).toBeUndefined();
  });

  it("separates cumulative samples so repeated exports cannot overstate usage", () => {
    const cumulative = grokOtlpFixture({ input: 46, cache_read: 34, output: 5, reasoning: 6 }, 2);
    expect(parseGrokOtlpMetrics(cumulative)).toBeUndefined();
    expect(parseGrokOtlpMetricSamples(cumulative)?.cumulative).toEqual({ inputTotal: 46, inputCached: 34, output: 5, reasoning: 6 });
  });

  it("accepts only authenticated protobuf metrics and stores no payload attributes", async () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "grok-tty", provider: "grok", mode: "observe", startedAt: now, endedAt: now, collectionState: "pending", taskKind: "unknown", outcome: "unknown" });
    const receiver = await startGrokMetricsReceiver(database, "grok-tty");
    expect(receiver.environment).toMatchObject({
      GROK_EXTERNAL_OTEL: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
      OTEL_METRICS_INCLUDE_SESSION_ID: "0",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_DETAILS: "0"
    });
    const response = await fetch(receiver.endpoint, {
      method: "POST",
      headers: { ...receiver.headers, "content-type": "application/x-protobuf" },
      body: grokOtlpFixture({ input: 46, cache_read: 34, output: 5, reasoning: 6 })
    });
    expect(response.status).toBe(200);
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({
      provider: "grok", inputNew: 12, inputCached: 34, cacheCreated: 0, output: 5, reasoning: 6
    });
    const rejected = await fetch(receiver.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: grokOtlpFixture({ input: 999 })
    });
    expect(rejected.status).toBe(404);
    await receiver.close();
    database.close();
    expect(fs.readFileSync(paths.databaseFile).toString("latin1")).not.toContain("person@example.test");
    cleanup(paths);
  });

  it("sums growing per-call delta usage without mistaking it for cumulative snapshots", async () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "grok-growing-context", provider: "grok", mode: "reduce", startedAt: now, collectionState: "pending", taskKind: "unknown", outcome: "unknown" });
    const receiver = await startGrokMetricsReceiver(database, "grok-growing-context");
    const calls = [
      { input: 20_000, cache_read: 1_000, output: 200, reasoning: 80 },
      { input: 41_000, cache_read: 19_000, output: 120, reasoning: 60 },
      { input: 47_000, cache_read: 22_000, output: 350, reasoning: 40 }
    ];
    for (const call of calls) {
      const response = await fetch(receiver.endpoint, {
        method: "POST",
        headers: { ...receiver.headers, "content-type": "application/x-protobuf" },
        body: grokOtlpFixture(call)
      });
      expect(response.status).toBe(200);
    }
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({
      provider: "grok",
      inputNew: 66_000,
      inputCached: 42_000,
      output: 670,
      reasoning: 180
    });
    await receiver.close();
    database.close();
    cleanup(paths);
  });

  it("gates TTY/TUI telemetry to the documented Grok Build version", () => {
    expect(supportsGrokExternalOtelVersion("1.0.3")).toBe(true);
    expect(supportsGrokExternalOtelVersion("1.1.0")).toBe(true);
    expect(supportsGrokExternalOtelVersion("1.0.2")).toBe(false);
    expect(supportsGrokExternalOtelVersion(undefined)).toBe(false);
  });
});
