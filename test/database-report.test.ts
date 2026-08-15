import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { buildReport, reportMarkdown, reportSummaryMarkdown, treatmentComparisons } from "../src/report.js";
import type { PricingProfile, SessionSummary } from "../src/types.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("aggregate reporting", () => {
  const pricedCodex: PricingProfile = {
    id: "codex-local-example",
    provider: "codex",
    version: "2026-08-14",
    label: "Manually verified example",
    currency: "USD",
    rates: {
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,
      cacheCreationUsdPerMillion: 20,
      outputUsdPerMillion: 30,
      reasoningUsdPerMillion: 40
    }
  };

  function pricedSessions(taskKind: SessionSummary["taskKind"] = "feature", profile = pricedCodex): SessionSummary[] {
    return (["observe", "balanced"] as const).flatMap((mode) => Array.from({ length: 5 }, (_, index) => ({
      id: `${mode}-${index}`,
      provider: "codex" as const,
      mode,
      optimizationApplied: mode === "balanced",
      optimizationProfile: mode === "balanced" ? "codex-balanced-v1" : undefined,
      comparisonProfile: "codex-balanced-v1",
      taskKind,
      outcome: "completed" as const,
      durationSeconds: mode === "observe" ? 20 : 15,
      inputNew: mode === "observe" ? 1_000_000 : 500_000,
      inputCached: mode === "observe" ? 1_000_000 : 500_000,
      cacheCreated: 0,
      output: mode === "observe" ? 1_000_000 : 500_000,
      reasoning: mode === "observe" ? 1_000_000 : 500_000,
      measurementBasis: "token-pressure" as const,
      pricingCompatible: true,
      pricingProfile: profile,
      compactions: 0,
      retries: 0
    })));
  }

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

  it("recognizes the versioned Grok JSON source as a cache-inclusive provider total after migration", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "grok-legacy", provider: "grok", mode: "observe", startedAt: now, endedAt: now, collectionState: "collected", taskKind: "benchmark", outcome: "completed" });
    database.addUsage({ runId: "grok-legacy", observedAt: now, source: "grok-cli-json-usage-v1", inputNew: 10, inputCached: 90, cacheCreated: 0, output: 0, reportedTotal: 100 });
    expect(database.sessionSummariesSince(new Date(Date.now() - 60_000).toISOString())).toMatchObject([{ reportedTotal: 100, reportedTotalIncludesCachedInput: true }]);
    database.close();
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
      baselineExpectedTreatmentTokens: 700,
      treatmentRecordedTokens: 600,
      estimatedTokensAvoided: 100,
      tokenReductionPercent: 100 / 700 * 100,
      tokenPressureDeltaPercent: -40,
      latencyDeltaSeconds: -5,
      latencyDeltaPercent: -(5 / 30) * 100,
      latencyResult: "faster",
      readiness: "preliminary",
      tokenResult: "preliminary-signal"
    });
  });

  it("does not manufacture a reduction when cache reads make the complete category total larger", () => {
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
      baselineExpectedTreatmentTokens: 505,
      treatmentRecordedTokens: 500350,
      estimatedTokensAvoided: -499845,
      readiness: "ready",
      tokenResult: "preliminary-signal"
    });
  });

  it("labels a flat category total with moved new input as cache-shift, including for Claude", () => {
    const sessions: SessionSummary[] = (["observe", "balanced"] as const).flatMap((mode) => Array.from({ length: 5 }, (_, index) => ({
      id: `${mode}-${index}`,
      provider: "claude" as const,
      mode,
      optimizationApplied: mode === "balanced",
      optimizationProfile: mode === "balanced" ? "claude-balanced-v2" : undefined,
      comparisonProfile: "claude-balanced-v2",
      taskKind: "feature" as const,
      outcome: "completed" as const,
      durationSeconds: 5,
      inputNew: mode === "observe" ? 7_543 : 120,
      inputCached: mode === "observe" ? 11_520 : 18_944,
      cacheCreated: 0,
      output: mode === "observe" ? 64 : 48,
      reasoning: 0,
      categoryMetricsComplete: true,
      measurementBasis: "token-pressure" as const,
      compactions: 0,
      retries: 0
    })));
    const [comparison] = treatmentComparisons(sessions);
    expect(comparison).toMatchObject({
      totalSource: "category total",
      baselineMedianComparableTotal: 19_127,
      treatmentMedianComparableTotal: 19_112,
      tokenResult: "cache-shift",
      estimatedTokensAvoided: undefined,
      estimatedUsdAvoided: undefined
    });
    const summary = reportSummaryMarkdown({
      generatedAt: "now",
      since: "then",
      rows: [],
      coverage: [{ provider: "claude", sessions: 10, measuredSessions: 10, unavailableSessions: 0 }],
      comparisons: [comparison]
    });
    expect(summary).toContain("cache-shift — no reduction emitted");
    expect(summary).not.toContain("97.4%");
    expect(summary).not.toContain("feature/claude-balanced-v2: 97.4% validated reduction");
    const serialized = JSON.stringify(comparison);
    expect(serialized).not.toContain("estimatedTokensAvoided");
    expect(serialized).not.toContain("tokenReductionPercent");
    expect(serialized).not.toContain("estimatedUsdAvoided");
  });

  it("allows Claude category totals to produce a validated reduction when cache is stable", () => {
    const sessions: SessionSummary[] = (["observe", "balanced"] as const).flatMap((mode) => Array.from({ length: 5 }, (_, index) => ({
      id: `claude-${mode}-${index}`,
      provider: "claude" as const,
      mode,
      optimizationApplied: mode === "balanced",
      optimizationProfile: mode === "balanced" ? "claude-balanced-v2" : undefined,
      comparisonProfile: "claude-balanced-v2",
      taskKind: "feature" as const,
      outcome: "completed" as const,
      durationSeconds: 4,
      inputNew: mode === "observe" ? 100 : 50,
      inputCached: 10,
      cacheCreated: 0,
      output: 10,
      reasoning: 0,
      categoryMetricsComplete: true,
      measurementBasis: "token-pressure" as const,
      compactions: 0,
      retries: 0
    })));
    const [comparison] = treatmentComparisons(sessions);
    expect(comparison).toMatchObject({ totalSource: "category total", tokenResult: "validated-reduction", tokenReductionPercent: 100 / 120 * 50 });
  });

  it("shows Grok TTY coverage as limited rather than estimating zero", () => {
    const summary = reportSummaryMarkdown({
      generatedAt: "now",
      since: "then",
      rows: [],
      coverage: [{ provider: "grok", sessions: 3, measuredSessions: 0, unavailableSessions: 3 }],
      comparisons: []
    });
    expect(summary).toContain("limited measurement");
    expect(summary).toContain("no comparable numeric session");
    expect(summary).not.toContain("0.0% reduction");
  });

  it("does not call increased complete totals a reduction", () => {
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
      tokenResult: "preliminary-signal"
    });
  });

  it("calculates reproducible API-equivalent USD only from compatible categories", () => {
    const [comparison] = treatmentComparisons(pricedSessions());
    expect(comparison).toMatchObject({
      readiness: "ready",
      pricingProfile: { id: "codex-local-example", version: "2026-08-14" },
      baselineExpectedUsd: 405,
      treatmentRecordedUsd: 202.5,
      estimatedUsdAvoided: 202.5,
      usdReductionPercent: 50
    });
  });

  it("does not compare sessions whose price snapshots differ, even when profile ids match", () => {
    const changed: PricingProfile = {
      ...pricedCodex,
      rates: { ...pricedCodex.rates, outputUsdPerMillion: 31 }
    };
    const baseline = pricedSessions().filter((session) => session.mode === "observe");
    const treatment = pricedSessions("feature", changed).filter((session) => session.mode === "balanced");
    expect(treatmentComparisons([...baseline, ...treatment])).toEqual([]);
  });

  it("keeps unknown and benchmark work preliminary even after five measured sessions per arm", () => {
    for (const taskKind of ["unknown", "benchmark"] as const) {
      const [comparison] = treatmentComparisons(pricedSessions(taskKind));
      expect(comparison).toMatchObject({ taskKind, baselineSessions: 5, treatmentSessions: 5, readiness: "preliminary", tokenResult: "preliminary-signal" });
    }
  });

  it("never converts a provider-reported total to USD without category metrics", () => {
    const sessions: SessionSummary[] = (["observe", "balanced"] as const).flatMap((mode) => Array.from({ length: 5 }, (_, index) => ({
      id: `total-${mode}-${index}`,
      provider: "codex",
      mode,
      optimizationApplied: mode === "balanced",
      optimizationProfile: mode === "balanced" ? "codex-balanced-v1" : undefined,
      comparisonProfile: "codex-balanced-v1",
      taskKind: "feature",
      outcome: "completed",
      durationSeconds: 1,
      inputNew: 0,
      inputCached: 0,
      cacheCreated: 0,
      output: 0,
      reasoning: 0,
      reportedTotal: mode === "observe" ? 100 : 50,
      reportedTotalIncludesCachedInput: true,
      categoryMetricsComplete: false,
      measurementBasis: "provider-total",
      pricingProfile: pricedCodex,
      pricingCompatible: false,
      compactions: 0,
      retries: 0
    })));
    const [comparison] = treatmentComparisons(sessions);
    expect(comparison).toMatchObject({ tokenResult: "validated-reduction", baselineExpectedUsd: undefined, treatmentRecordedUsd: undefined, estimatedUsdAvoided: undefined });
  });

  it("stores the selected price profile inside the session record", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "price-snapshot", provider: "codex", mode: "observe", startedAt: now, pricingProfile: pricedCodex, collectionState: "pending", taskKind: "unknown", outcome: "unknown" });
    expect(database.getRun("price-snapshot")).toMatchObject({ pricingProfile: pricedCodex });
    database.close();
    cleanup(paths);
  });

  it("renders audit evidence and distinguishes API-equivalent USD from a provider bill", () => {
    const comparisons = treatmentComparisons([
      { id: "observe", provider: "codex", mode: "observe", optimizationApplied: false, comparisonProfile: "codex-balanced-v1", taskKind: "benchmark", outcome: "completed", durationSeconds: 1, inputNew: 0, inputCached: 0, cacheCreated: 0, output: 0, reasoning: 0, reportedTotal: 100, reportedTotalIncludesCachedInput: true, categoryMetricsComplete: false, measurementBasis: "provider-total", compactions: 0, retries: 0 },
      { id: "balanced", provider: "codex", mode: "balanced", optimizationApplied: true, optimizationProfile: "codex-balanced-v1", comparisonProfile: "codex-balanced-v1", taskKind: "benchmark", outcome: "completed", durationSeconds: 1, inputNew: 0, inputCached: 0, cacheCreated: 0, output: 0, reasoning: 0, reportedTotal: 80, reportedTotalIncludesCachedInput: true, categoryMetricsComplete: false, measurementBasis: "provider-total", compactions: 0, retries: 0 }
    ]);
    const markdown = reportMarkdown({ generatedAt: "now", since: "then", rows: [], coverage: [], comparisons });
    expect(markdown).toContain("## Matched audit comparisons");
    expect(markdown).toContain("baseline: observe");
    expect(markdown).toContain("## API-equivalent USD");
    expect(markdown).toContain("not a provider bill");
    expect(markdown).toContain("preliminary signal");
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
