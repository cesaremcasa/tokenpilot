import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { parseClaudeOtlpMetricSamples, parseClaudeOtlpMetrics, startClaudeMetricsReceiver } from "../src/telemetry/claude.js";
import { cleanup, temporaryPaths } from "./helpers.js";

const payload = {
  resourceMetrics: [{
    resource: { attributes: [{ key: "user.email", value: { stringValue: "person@example.test" } }] },
    scopeMetrics: [{
      metrics: [{
        name: "claude_code.token.usage",
        sum: {
          aggregationTemporality: 1,
          dataPoints: [
            { attributes: [{ key: "type", value: { stringValue: "input" } }], asInt: "11" },
            { attributes: [{ key: "type", value: { stringValue: "cacheRead" } }], asInt: "13" },
            { attributes: [{ key: "type", value: { stringValue: "cacheCreation" } }], asInt: "17" },
            { attributes: [{ key: "type", value: { stringValue: "output" } }], asInt: "19" }
          ]
        }
      }]
    }]
  }]
};

describe("Claude metrics-only receiver", () => {
  it("extracts only documented numeric token counters", () => {
    expect(parseClaudeOtlpMetrics(payload)).toEqual({ inputNew: 11, inputCached: 13, cacheCreated: 17, output: 19 });
    expect(parseClaudeOtlpMetrics({ resourceMetrics: [] })).toBeUndefined();
  });

  it("rejects cumulative counters so repeated exports cannot overstate usage", () => {
    const cumulative = structuredClone(payload);
    cumulative.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 2;
    expect(parseClaudeOtlpMetrics(cumulative)).toBeUndefined();
    expect(parseClaudeOtlpMetricSamples(cumulative)?.cumulative).toEqual({ inputNew: 11, inputCached: 13, cacheCreated: 17, output: 19 });
  });

  it("accepts authenticated local OTLP JSON and stores no payload fields", async () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "claude-run", provider: "claude", mode: "observe", startedAt: now, endedAt: now, collectionState: "pending", taskKind: "unknown", outcome: "unknown" });
    const receiver = await startClaudeMetricsReceiver(database, "claude-run");
    const response = await fetch(receiver.endpoint, {
      method: "POST",
      headers: { ...receiver.headers, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(response.status).toBe(200);
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({
      provider: "claude", inputNew: 11, inputCached: 13, cacheCreated: 17, output: 19
    });
    const rejected = await fetch(receiver.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(rejected.status).toBe(404);
    await receiver.close();
    database.close();
    expect(fs.readFileSync(paths.databaseFile).toString("latin1")).not.toContain("person@example.test");
    cleanup(paths);
  });

  it("converts cumulative OTel snapshots to incremental local usage", async () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "claude-cumulative", provider: "claude", mode: "observe", startedAt: now, endedAt: now, collectionState: "pending", taskKind: "unknown", outcome: "unknown" });
    const receiver = await startClaudeMetricsReceiver(database, "claude-cumulative");
    const cumulative = structuredClone(payload);
    cumulative.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 2;
    const second = structuredClone(cumulative);
    second.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt = "29";
    second.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[1].asInt = "31";
    second.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[2].asInt = "37";
    second.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[3].asInt = "41";
    for (const sample of [cumulative, second]) {
      const response = await fetch(receiver.endpoint, { method: "POST", headers: { ...receiver.headers, "content-type": "application/json" }, body: JSON.stringify(sample) });
      expect(response.status).toBe(200);
    }
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ inputNew: 29, inputCached: 31, cacheCreated: 37, output: 41 });
    await receiver.close();
    database.close();
    cleanup(paths);
  });
});
