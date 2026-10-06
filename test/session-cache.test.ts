import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { buildReport, filterReportByProvider, reportSummaryMarkdown } from "../src/report.js";
import type { Provider, UsageMetrics } from "../src/types.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("session cache percentages", () => {
  function scenario(test: (database: TelemetryDatabase, report: (provider?: Provider) => ReturnType<typeof buildReport>, add: (usage?: UsageMetrics, offset?: number, source?: string) => string) => void) {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const add = (usage?: UsageMetrics, offset = 0, source = "codex-exec-json-usage-v1") => {
      const id = randomUUID();
      const startedAt = new Date(Date.now() + offset).toISOString();
      database.createRun({ id, provider: "codex", mode: "observe", startedAt, optimizationApplied: false, collectionState: usage ? "collected" : "pending", taskKind: "unknown", outcome: "unknown" });
      if (usage) database.addUsage({ runId: id, source, observedAt: startedAt, ...usage });
      return id;
    };
    try { test(database, (provider = "codex") => filterReportByProvider(buildReport(paths, 7), provider), add); }
    finally { database.close(); cleanup(paths); }
  }

  it("excludes output and treats cache creation as non-reused input", () => scenario((_db, report, add) => {
    add({ inputNew: 50, inputCached: 50, cacheCreated: 25, output: 900 }, 0, "codex-otlp-metrics-v2");
    const text = reportSummaryMarkdown(report());
    expect(text).toContain("Approximate reduction in uncached input: 50%");
    expect(text).toContain("Uncached input: 50%");
    expect(text).not.toContain("900");
    expect(text).not.toContain("redução");
  }));

  it("accepts explicit zero cache but not zero total input", () => scenario((_db, report, add) => {
    add({ inputNew: 100, inputCached: 0, cacheCreated: 0 });
    expect(reportSummaryMarkdown(report())).toContain("Approximate reduction in uncached input: 0%");
    add({ inputNew: 0, inputCached: 0, cacheCreated: 0 }, 1);
    expect(reportSummaryMarkdown(report())).toContain("Percentage unavailable");
  }));

  it("does not fall back to an older measured session", () => scenario((_db, report, add) => {
    add({ inputNew: 50, inputCached: 50, cacheCreated: 0 });
    add(undefined, 1);
    expect(reportSummaryMarkdown(report())).toContain("Percentage unavailable");
    expect(reportSummaryMarkdown(report())).not.toContain("50%");
  }));

  it("uses the exact inherited run rather than a concurrent newer run", () => scenario((_db, report, add) => {
    const current = add({ inputNew: 75, inputCached: 25, cacheCreated: 0 });
    add({ inputNew: 10, inputCached: 90, cacheCreated: 0 }, 1);
    expect(reportSummaryMarkdown(report(), current)).toContain("Approximate reduction in uncached input: 25%");
    expect(reportSummaryMarkdown(report(), randomUUID())).toContain("Percentage unavailable");
  }));

  it("uses verified provider totals when optional cache-write counters are absent", () => scenario((_db, report, add) => {
    add({ inputNew: 17582, inputCached: 6912, output: 21, reportedTotal: 24515, reportedTotalIncludesCachedInput: true });
    expect(reportSummaryMarkdown(report())).toContain("Approximate reduction in uncached input: 28.2%");
    expect(reportSummaryMarkdown(report())).toContain("Uncached input: 71.8%");
  }));

  it("rejects conflicting totals and missing cached counters", () => scenario((_db, report, add) => {
    add({ inputNew: 50, inputCached: 50, cacheCreated: 0, output: 10, reportedTotal: 120, reportedTotalIncludesCachedInput: true });
    expect(reportSummaryMarkdown(report())).toContain("Percentage unavailable");
    add({ inputNew: 100, output: 10, reportedTotal: 110, reportedTotalIncludesCachedInput: true }, 1);
    expect(reportSummaryMarkdown(report())).toContain("Percentage unavailable");
  }));

  it("does not combine duplicate sources", () => scenario((db, report, add) => {
    const id = add({ inputNew: 50, inputCached: 50, cacheCreated: 0 });
    db.addUsage({ runId: id, observedAt: new Date().toISOString(), source: "codex-otlp-metrics-v2", inputNew: 50, inputCached: 50, cacheCreated: 0 });
    expect(reportSummaryMarkdown(report())).toContain("Percentage unavailable");
  }));

  it("does not turn a missing counter in a later sample into zero", () => scenario((db, report, add) => {
    const id = add({ inputNew: 50, inputCached: 50, cacheCreated: 0 });
    db.addUsage({ runId: id, observedAt: new Date().toISOString(), source: "codex-exec-json-usage-v1", inputNew: 100 });
    expect(reportSummaryMarkdown(report())).toContain("Percentage unavailable");
  }));

  it("rounds complementary percentages to exactly one hundred", () => scenario((_db, report, add) => {
    add({ inputNew: 6665, inputCached: 3335, cacheCreated: 0 });
    const text = reportSummaryMarkdown(report());
    expect(text).toContain("Approximate reduction in uncached input: 33.4%");
    expect(text).toContain("Uncached input: 66.6%");
  }));

  it("shows a missing recent session without reviving historical data", () => scenario((_db, report, add) => {
    add({ inputNew: 50, inputCached: 50, cacheCreated: 0 }, -8 * 24 * 60 * 60 * 1000);
    expect(reportSummaryMarkdown(report())).toContain("Percentage unavailable");
    expect(reportSummaryMarkdown(report())).not.toContain("50%");
  }));

  it.each(["claude", "grok"] as const)("uses the same cache formula for %s", (provider) => scenario((db, report) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createRun({ id, provider, mode: "observe", startedAt: now, optimizationApplied: false, collectionState: "collected", taskKind: "unknown", outcome: "unknown" });
    db.addUsage({ runId: id, observedAt: now, source: `${provider}-otlp-metrics-v2`, inputNew: 25, inputCached: 50, cacheCreated: 25, output: 900 });
    expect(reportSummaryMarkdown(report(provider))).toContain("Approximate reduction in uncached input: 50%");
  }));
});
