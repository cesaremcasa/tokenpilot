import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { buildReport, reportMarkdown, treatmentComparisons } from "../src/report.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("aggregate reporting", () => {
  it("groups only aggregate numeric data by provider, mode, and task kind", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "run-1", provider: "codex", mode: "observe", startedAt: now, endedAt: now, exitCode: 0, optimizationApplied: false, collectionState: "pending", taskKind: "bugfix", outcome: "completed" });
    database.addUsage({ runId: "run-1", observedAt: now, source: "codex", inputNew: 10, inputCached: 100, output: 4 });
    database.addEvent({ runId: "run-1", observedAt: now, source: "codex", type: "retry", count: 1 });
    database.close();

    const report = buildReport(paths, 7);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ provider: "codex", optimizationApplied: false, taskKind: "bugfix", sessions: 1, inputNew: 10, inputCached: 100, retries: 1 });
    expect(report.coverage).toEqual([{ provider: "codex", sessions: 1, measuredSessions: 1, unavailableSessions: 0 }]);
    expect(reportMarkdown(report)).toContain("codex");
    cleanup(paths);
  });

  it("compares matched treatment sessions by median and variation without crossing providers", () => {
    const comparisons = treatmentComparisons([
      { id: "observe-1", provider: "codex", mode: "observe", optimizationApplied: false, taskKind: "bugfix", outcome: "completed", durationSeconds: 20, inputNew: 100, inputCached: 500, cacheCreated: 0, output: 20, reasoning: 80, compactions: 0, retries: 0 },
      { id: "observe-2", provider: "codex", mode: "observe", optimizationApplied: false, taskKind: "bugfix", outcome: "completed", durationSeconds: 40, inputNew: 200, inputCached: 400, cacheCreated: 0, output: 20, reasoning: 80, compactions: 0, retries: 1 },
      { id: "balanced-1", provider: "codex", mode: "balanced", optimizationApplied: true, optimizationProfile: "codex-balanced-v1", taskKind: "bugfix", outcome: "completed", durationSeconds: 25, inputNew: 75, inputCached: 450, cacheCreated: 0, output: 15, reasoning: 60, compactions: 0, retries: 0 },
      { id: "other-provider", provider: "claude", mode: "balanced", optimizationApplied: true, optimizationProfile: "claude-balanced-v1", taskKind: "bugfix", outcome: "completed", durationSeconds: 25, inputNew: 1, inputCached: 1, cacheCreated: 0, output: 1, reasoning: 1, compactions: 0, retries: 0 }
    ]);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      provider: "codex",
      optimizationProfile: "codex-balanced-v1",
      baselineSessions: 2,
      treatmentSessions: 1,
      tokenPressureDeltaPercent: -40,
      readiness: "preliminary"
    });
  });
});
