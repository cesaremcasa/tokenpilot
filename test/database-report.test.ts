import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { buildReport, reportMarkdown, treatmentComparisons } from "../src/report.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("aggregate reporting", () => {
  it("returns an empty report without creating telemetry state", () => {
    const paths = temporaryPaths();
    const report = buildReport(paths, 7);
    expect(report).toMatchObject({ rows: [], coverage: [], comparisons: [] });
    expect(fs.existsSync(paths.dataDir)).toBe(false);
    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    cleanup(paths);
  });

  it("groups only aggregate numeric data by provider, mode, and task kind", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "run-1", provider: "codex", mode: "observe", startedAt: now, endedAt: now, exitCode: 0, optimizationApplied: false, collectionState: "pending", taskKind: "bugfix", outcome: "completed" });
    database.addUsage({ runId: "run-1", observedAt: now, source: "codex", inputNew: 10, inputCached: 100, output: 4, reportedTotal: 114 });
    database.addEvent({ runId: "run-1", observedAt: now, source: "codex", type: "retry", count: 1 });
    database.close();

    const report = buildReport(paths, 7);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ provider: "codex", optimizationApplied: false, taskKind: "bugfix", sessions: 1, inputNew: 10, inputCached: 100, reportedTotal: 114, retries: 1 });
    expect(report.coverage).toEqual([{ provider: "codex", sessions: 1, measuredSessions: 1, unavailableSessions: 0 }]);
    expect(reportMarkdown(report)).toContain("codex");
    cleanup(paths);
  });

  it("compares matched treatment sessions by median and variation without crossing providers", () => {
    const comparisons = treatmentComparisons([
      { id: "observe-1", provider: "codex", mode: "observe", optimizationApplied: false, comparisonProfile: "codex-balanced-v1", taskKind: "bugfix", outcome: "completed", durationSeconds: 20, inputNew: 100, inputCached: 500, cacheCreated: 0, output: 20, reasoning: 80, compactions: 0, retries: 0 },
      { id: "observe-2", provider: "codex", mode: "observe", optimizationApplied: false, comparisonProfile: "codex-balanced-v1", taskKind: "bugfix", outcome: "completed", durationSeconds: 40, inputNew: 200, inputCached: 400, cacheCreated: 0, output: 20, reasoning: 80, compactions: 0, retries: 1 },
      { id: "balanced-1", provider: "codex", mode: "balanced", optimizationApplied: true, optimizationProfile: "codex-balanced-v1", comparisonProfile: "codex-balanced-v1", taskKind: "bugfix", outcome: "completed", durationSeconds: 25, inputNew: 75, inputCached: 450, cacheCreated: 0, output: 15, reasoning: 60, compactions: 0, retries: 0 },
      { id: "other-provider", provider: "claude", mode: "balanced", optimizationApplied: true, optimizationProfile: "claude-balanced-v1", taskKind: "bugfix", outcome: "completed", durationSeconds: 25, inputNew: 1, inputCached: 1, cacheCreated: 0, output: 1, reasoning: 1, compactions: 0, retries: 0 }
    ]);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      provider: "codex",
      optimizationProfile: "codex-balanced-v1",
      baselineSessions: 2,
      treatmentSessions: 1,
      baselineExpectedTreatmentTokens: 250,
      treatmentRecordedTokens: 150,
      estimatedTokensAvoided: 100,
      tokenReductionPercent: 40,
      tokenPressureDeltaPercent: -40,
      latencyDeltaSeconds: -5,
      latencyDeltaPercent: -(5 / 30) * 100,
      latencyResult: "faster",
      readiness: "preliminary",
      tokenResult: "preliminary"
    });
  });

  it("calculates token-only avoidance from a matched baseline without counting cache reads", () => {
    const sessions = (["observe", "balanced"] as const).flatMap((mode) => Array.from({ length: 5 }, (_, index) => ({
      id: `${mode}-${index}`,
      provider: "grok" as const,
      mode,
      optimizationApplied: mode === "balanced",
      optimizationProfile: mode === "balanced" ? "grok-balanced-v1" : undefined,
      comparisonProfile: "grok-balanced-v1",
      taskKind: "feature" as const,
      outcome: "unknown" as const,
      durationSeconds: 10,
      inputNew: mode === "observe" ? 100 : 70,
      // A radically different cache-read value must not manufacture a saving.
      inputCached: mode === "observe" ? 1 : 100_000,
      cacheCreated: 0,
      output: 0,
      reasoning: 0,
      compactions: 0,
      retries: 0
    })));
    const [comparison] = treatmentComparisons(sessions);
    expect(comparison).toMatchObject({
      baselineExpectedTreatmentTokens: 500,
      treatmentRecordedTokens: 350,
      estimatedTokensAvoided: 150,
      readiness: "ready",
      tokenResult: "measured-reduction"
    });
  });

  it("reports a ready non-reduction instead of hiding increased token use", () => {
    const sessions = (["observe", "balanced"] as const).flatMap((mode) => Array.from({ length: 5 }, (_, index) => ({
      id: `${mode}-${index}`,
      provider: "claude" as const,
      mode,
      optimizationApplied: mode === "balanced",
      optimizationProfile: mode === "balanced" ? "claude-balanced-v2" : undefined,
      comparisonProfile: "claude-balanced-v2",
      taskKind: "research" as const,
      outcome: "unknown" as const,
      durationSeconds: 10,
      inputNew: mode === "observe" ? 100 : 120,
      inputCached: 0,
      cacheCreated: 0,
      output: 0,
      reasoning: 0,
      compactions: 0,
      retries: 0
    })));
    const [comparison] = treatmentComparisons(sessions);
    expect(comparison).toMatchObject({
      estimatedTokensAvoided: -100,
      readiness: "ready",
      tokenResult: "no-reduction"
    });
  });

  it("renders the counterfactual token calculation without a money conversion", () => {
    const comparisons = treatmentComparisons([
      { id: "observe", provider: "codex", mode: "observe", optimizationApplied: false, comparisonProfile: "codex-balanced-v1", taskKind: "benchmark", outcome: "completed", durationSeconds: 1, inputNew: 0, inputCached: 0, cacheCreated: 0, output: 0, reasoning: 0, reportedTotal: 100, measurementBasis: "provider-total", compactions: 0, retries: 0 },
      { id: "balanced", provider: "codex", mode: "balanced", optimizationApplied: true, optimizationProfile: "codex-balanced-v1", comparisonProfile: "codex-balanced-v1", taskKind: "benchmark", outcome: "completed", durationSeconds: 1, inputNew: 0, inputCached: 0, cacheCreated: 0, output: 0, reasoning: 0, reportedTotal: 80, measurementBasis: "provider-total", compactions: 0, retries: 0 }
    ]);
    const markdown = reportMarkdown({ generatedAt: "now", since: "then", rows: [], coverage: [], comparisons });
    expect(markdown).toContain("## Estimated token avoidance");
    expect(markdown).toContain("Estimated tokens avoided");
    expect(markdown).toContain("not a provider invoice and not a money calculation");
    expect(markdown).toContain("## Reduction and latency summary");
    expect(markdown).toContain("Baseline expected");
    expect(markdown).toContain("Actual tokens used");
    expect(markdown).toContain("not tokens blocked by the provider");
    expect(markdown).toContain("| codex | benchmark | codex-balanced-v1 | preliminary | 100 | 80 | 20 | 20.0% reduction");
    expect(markdown).toContain("20.0% reduction");
  });

  it("does not compare a treatment with a baseline assigned to another policy version", () => {
    const comparisons = treatmentComparisons([
      { id: "old-observe", provider: "claude", mode: "observe", optimizationApplied: false, comparisonProfile: "claude-balanced-v1", taskKind: "feature", outcome: "unknown", durationSeconds: 10, inputNew: 100, inputCached: 0, cacheCreated: 0, output: 10, reasoning: 0, compactions: 0, retries: 0 },
      { id: "new-treatment", provider: "claude", mode: "balanced", optimizationApplied: true, optimizationProfile: "claude-balanced-v2", comparisonProfile: "claude-balanced-v2", taskKind: "feature", outcome: "unknown", durationSeconds: 10, inputNew: 50, inputCached: 0, cacheCreated: 0, output: 10, reasoning: 0, compactions: 0, retries: 0 }
    ]);
    expect(comparisons).toEqual([]);
  });

  it("lists only content-free run metadata for optional classification", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "newer", provider: "grok", mode: "balanced", startedAt: now, optimizationApplied: true, optimizationProfile: "grok-balanced-v1", comparisonProfile: "grok-balanced-v1", collectionState: "pending", taskKind: "unknown", outcome: "unknown" });
    database.createRun({ id: "classified", provider: "claude", mode: "observe", startedAt: now, optimizationApplied: false, comparisonProfile: "claude-balanced-v2", collectionState: "pending", taskKind: "feature", outcome: "completed" });
    expect(database.recentRunsSince(new Date(Date.now() - 60_000).toISOString())).toHaveLength(2);
    expect(database.recentRunsSince(new Date(Date.now() - 60_000).toISOString(), true)).toMatchObject([{ id: "newer", provider: "grok", comparisonProfile: "grok-balanced-v1", taskKind: "unknown" }]);
    database.close();
    cleanup(paths);
  });

  it("opens an existing report database without changing its file", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    database.close();
    const before = fs.statSync(paths.databaseFile).mtimeMs;
    const walFile = `${paths.databaseFile}-wal`;
    const walBefore = fs.existsSync(walFile) ? fs.statSync(walFile).mtimeMs : undefined;

    buildReport(paths, 7);

    expect(fs.statSync(paths.databaseFile).mtimeMs).toBe(before);
    expect(fs.existsSync(walFile)).toBe(walBefore !== undefined);
    if (walBefore !== undefined) expect(fs.statSync(walFile).mtimeMs).toBe(walBefore);
    cleanup(paths);
  });

  it("refuses a legacy WAL database rather than creating report sidecar files", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    database.close();
    const legacy = new DatabaseSync(paths.databaseFile);
    legacy.exec("PRAGMA journal_mode = WAL;");
    legacy.close();
    const before = fs.statSync(paths.databaseFile).mtimeMs;
    const walFile = `${paths.databaseFile}-wal`;
    const walBefore = fs.existsSync(walFile);

    expect(() => buildReport(paths, 7)).toThrow("legacy WAL database");
    expect(fs.statSync(paths.databaseFile).mtimeMs).toBe(before);
    expect(fs.existsSync(walFile)).toBe(walBefore);
    cleanup(paths);
  });
});
