import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { CodexExecJsonUsageParser, CodexExecTokenParser, isCodexExec, isCodexJsonExec, parseCodexOtlpMetricSamples, parseCodexOtlpMetrics, startCodexMetricsReceiver } from "../src/telemetry/codex.js";
import { cleanup, temporaryPaths } from "./helpers.js";

const payload = {
  resourceMetrics: [{
    resource: { attributes: [{ key: "user.email", value: { stringValue: "person@example.test" } }] },
    scopeMetrics: [{
      metrics: [{
        name: "codex.turn.token_usage",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            { attributes: [{ key: "token_type", value: { stringValue: "input" } }], sum: 100 },
            { attributes: [{ key: "token_type", value: { stringValue: "cached_input" } }], sum: 40 },
            { attributes: [{ key: "token_type", value: { stringValue: "cache_write_input" } }], sum: 5 },
            { attributes: [{ key: "token_type", value: { stringValue: "output" } }], sum: 15 },
            { attributes: [{ key: "token_type", value: { stringValue: "reasoning_output" } }], sum: 10 },
            { attributes: [{ key: "token_type", value: { stringValue: "total" } }], sum: 125 }
          ]
        }
      }]
    }]
  }]
};

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

  it("extracts only cache-aware numeric usage from Codex JSONL events", () => {
    const parser = new CodexExecJsonUsageParser();
    parser.accept('{"type":"item.completed","item":{"type":"agent_message","text":"private output"}}\n{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":15,"reasoning_output_tokens":10,"cache_write_input_tokens":3}}\n');

    expect(parser.finish()).toEqual({
      inputNew: 60,
      inputCached: 40,
      output: 15,
      reportedTotal: 115,
      reportedTotalIncludesCachedInput: true
    });
  });

  it("uses the latest cumulative JSON receipt without summing repeated totals", () => {
    const parser = new CodexExecJsonUsageParser();
    for (const usage of [
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 15 },
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 15 },
      { input_tokens: 200, cached_input_tokens: 90, output_tokens: 25 }
    ]) parser.accept(JSON.stringify({ type: "turn.completed", usage }) + "\n");
    expect(parser.finish()).toEqual({ inputNew: 110, inputCached: 90, output: 25, reportedTotal: 225, reportedTotalIncludesCachedInput: true });
  });

  it("rejects cumulative JSON counters that decrease", () => {
    const parser = new CodexExecJsonUsageParser();
    parser.accept('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":15}}\n');
    parser.accept('{"type":"turn.completed","usage":{"input_tokens":90,"output_tokens":15}}\n');
    expect(parser.finish()).toBeUndefined();
  });

  it("rejects decreasing cumulative cache counters", () => {
    const parser = new CodexExecJsonUsageParser();
    parser.accept('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":15}}\n');
    parser.accept('{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":30,"output_tokens":25}}\n');
    expect(parser.finish()).toBeUndefined();
  });

  it("keeps the provider total when category details are absent without filling zeros", () => {
    const parser = new CodexExecJsonUsageParser();
    parser.accept('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":15}}\n');

    expect(parser.finish()).toEqual({
      output: 15,
      reportedTotal: 115,
      reportedTotalIncludesCachedInput: true
    });
  });

  it("detects only Codex exec JSON mode before its prompt", () => {
    expect(isCodexJsonExec(["exec", "--json", "--model", "gpt-6-luna", "task"])).toBe(true);
    expect(isCodexJsonExec(["exec", "--model", "gpt-6-luna", "task --json"])).toBe(false);
    expect(isCodexJsonExec(["exec", "--", "--json"])).toBe(false);
  });

  it("extracts Codex's metrics-only token histogram and separates cache hits", () => {
    expect(parseCodexOtlpMetrics(payload)).toEqual({ inputNew: 60, inputCached: 40, cacheCreated: 5, output: 15, reasoning: 10, reportedTotal: 125 });
    expect(parseCodexOtlpMetrics({ resourceMetrics: [] })).toBeUndefined();
  });

  it("accepts only known token types and handles cumulative metrics without double counting", () => {
    const cumulative = structuredClone(payload);
    cumulative.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.aggregationTemporality = 2;
    expect(parseCodexOtlpMetrics(cumulative)).toBeUndefined();
    expect(parseCodexOtlpMetricSamples(cumulative)?.cumulative).toMatchObject({ input: 100, cached_input: 40, total: 125 });
  });

  it("stores only authenticated numeric Codex metrics and injects no persistent config", async () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "codex-run", provider: "codex", mode: "observe", startedAt: now, endedAt: now, collectionState: "pending", taskKind: "unknown", outcome: "unknown" });
    const receiver = await startCodexMetricsReceiver(database, "codex-run");
    expect(receiver.args.join("\n")).toContain("otel.metrics_exporter={");
    expect(receiver.args).toContain("otel.exporter=\"none\"");
    expect(receiver.args).toContain("otel.trace_exporter=\"none\"");
    expect(receiver.args).toContain("otel.log_user_prompt=false");
    const response = await fetch(receiver.endpoint, { method: "POST", headers: { ...receiver.headers, "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ provider: "codex", inputNew: 60, inputCached: 40, cacheCreated: 5, output: 15, reasoning: 10, reportedTotal: 125 });
    const rejected = await fetch(receiver.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(rejected.status).toBe(404);
    await receiver.close();
    database.close();
    expect(fs.readFileSync(paths.databaseFile).toString("latin1")).not.toContain("person@example.test");
    cleanup(paths);
  });
});
