import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { parseClaudeOtlpMetrics, startClaudeMetricsReceiver } from "../src/telemetry/claude.js";
import { cleanup, temporaryPaths } from "./helpers.js";

const payload = {
  resourceMetrics: [{
    resource: { attributes: [{ key: "user.email", value: { stringValue: "person@example.test" } }] },
    scopeMetrics: [{
      metrics: [{
        name: "claude_code.token.usage",
        sum: {
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
    cleanup(paths);
  });
});
