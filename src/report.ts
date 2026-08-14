import fs from "node:fs";
import type { AggregateRow, MeasurementCoverage, SessionSummary, TreatmentComparison } from "./types.js";
import { TelemetryDatabase } from "./database.js";
import { assertSafeStateFile, hasSafePrivateDirectory, type TokenPilotPaths } from "./paths.js";

export interface Report {
  generatedAt: string;
  since: string;
  rows: AggregateRow[];
  coverage: MeasurementCoverage[];
  comparisons: TreatmentComparison[];
}

function emptyReport(since: string): Report {
  return {
    generatedAt: new Date().toISOString(),
    since,
    rows: [],
    coverage: [],
    comparisons: []
  };
}

function usesLegacyWalDatabase(databaseFile: string): boolean {
  const descriptor = fs.openSync(databaseFile, "r");
  try {
    const header = Buffer.alloc(20);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    // SQLite database-header offsets 18 and 19 are the file-format read and
    // write versions. A value of 2 selects WAL. Opening it can create -wal or
    // -shm files even with a read-only connection, so never open it here.
    return bytesRead === header.length && (header[18] === 2 || header[19] === 2);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function buildReport(paths: TokenPilotPaths, days: number): Report {
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("--days must be between 1 and 365");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  // A report is intentionally read-only. Opening a missing SQLite file would
  // create personal state merely by invoking the installed skill, so return an
  // empty report until the first tracked provider session creates data.
  if (!fs.existsSync(paths.databaseFile)) return emptyReport(since);
  if (!hasSafePrivateDirectory(paths, paths.dataDir)) throw new Error("TokenPilot telemetry directory is unsafe");
  assertSafeStateFile(paths, paths.databaseFile);
  if (usesLegacyWalDatabase(paths.databaseFile)) {
    throw new Error("TokenPilot telemetry uses a legacy WAL database; start one personal session to migrate it before requesting a read-only report");
  }
  const database = new TelemetryDatabase(paths, { readOnly: true });
  try {
    const summaries = database.sessionSummariesSince(since);
    return {
      generatedAt: new Date().toISOString(),
      since,
      rows: database.aggregateSince(since),
      coverage: database.measurementCoverageSince(since),
      comparisons: treatmentComparisons(summaries)
    };
  } finally {
    database.close();
  }
}

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function interquartileRange(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  const percentile = (fraction: number) => {
    const index = (sorted.length - 1) * fraction;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  };
  return percentile(0.75) - percentile(0.25);
}

function tokenPressure(session: SessionSummary): number {
  // Cache reads are shown separately in the main table. This measure isolates
  // newly created context and generated work within one provider.
  return session.inputNew + session.cacheCreated + session.output + session.reasoning;
}

function measurementValue(session: SessionSummary): number | undefined {
  return session.measurementBasis === "provider-total" ? session.reportedTotal : tokenPressure(session);
}

function metricLabel(session: SessionSummary): TreatmentComparison["metricLabel"] {
  return session.measurementBasis === "provider-total" ? "provider-reported total" : "token pressure";
}

function completionRate(sessions: SessionSummary[]): number | undefined {
  const classified = sessions.filter((session) => session.outcome !== "unknown");
  if (classified.length === 0) return undefined;
  return classified.filter((session) => session.outcome === "completed").length / classified.length;
}

export function treatmentComparisons(summaries: SessionSummary[]): TreatmentComparison[] {
  const baselines = new Map<string, SessionSummary[]>();
  const treatments = new Map<string, SessionSummary[]>();
  for (const session of summaries) {
    if (measurementValue(session) === undefined) continue;
    const basis = session.measurementBasis ?? "token-pressure";
    const scope = `${session.provider}\u0000${session.taskKind}\u0000${basis}`;
    if (session.mode === "observe") baselines.set(scope, [...(baselines.get(scope) ?? []), session]);
    if (session.mode === "balanced" && session.optimizationApplied && session.optimizationProfile) {
      const key = `${scope}\u0000${session.optimizationProfile}`;
      treatments.set(key, [...(treatments.get(key) ?? []), session]);
    }
  }
  return [...treatments.entries()].flatMap(([key, treatment]) => {
    const [provider, taskKind, basis, optimizationProfile] = key.split("\u0000") as [TreatmentComparison["provider"], TreatmentComparison["taskKind"], NonNullable<SessionSummary["measurementBasis"]>, string];
    const baseline = baselines.get(`${provider}\u0000${taskKind}\u0000${basis}`) ?? [];
    if (baseline.length === 0) return [];
    const baselinePressure = baseline.map(measurementValue).filter((value): value is number => value !== undefined);
    const treatmentPressure = treatment.map(measurementValue).filter((value): value is number => value !== undefined);
    const baselineMedian = median(baselinePressure);
    const treatmentMedian = median(treatmentPressure);
    return [{
      provider,
      taskKind,
      optimizationProfile,
      metricLabel: metricLabel(treatment[0]),
      baselineSessions: baseline.length,
      treatmentSessions: treatment.length,
      baselineMedianTokenPressure: baselineMedian,
      treatmentMedianTokenPressure: treatmentMedian,
      tokenPressureDeltaPercent: baselineMedian === 0 ? 0 : ((treatmentMedian - baselineMedian) / baselineMedian) * 100,
      baselineIqrTokenPressure: interquartileRange(baselinePressure),
      treatmentIqrTokenPressure: interquartileRange(treatmentPressure),
      baselineMedianDurationSeconds: median(baseline.map((session) => session.durationSeconds)),
      treatmentMedianDurationSeconds: median(treatment.map((session) => session.durationSeconds)),
      baselineCompletionRate: completionRate(baseline),
      treatmentCompletionRate: completionRate(treatment),
      readiness: baseline.length >= 5 && treatment.length >= 5 ? "ready" as const : "preliminary" as const
    }];
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.taskKind.localeCompare(b.taskKind));
}

function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

export function reportMarkdown(report: Report): string {
  const lines = [
    "# TokenPilot — Personal telemetry report",
    "",
    `Generated: ${report.generatedAt}`,
    `Window: last seven days (starts ${report.since})`,
    "",
    "> This report contains aggregate numeric telemetry only. Do not compare raw token totals across providers.",
    "",
    "## Measurement coverage",
    "",
    "| Provider | Sessions | Measured | Unavailable |",
    "| --- | ---: | ---: | ---: |"
  ];
  for (const row of report.coverage) {
    lines.push(`| ${row.provider} | ${integer(row.sessions)} | ${integer(row.measuredSessions)} | ${integer(row.unavailableSessions)} |`);
  }
  if (report.coverage.length === 0) lines.push("| — | 0 | 0 | 0 |");
  lines.push(
    "",
    "## Session metrics",
    "",
    "| Provider | Mode | Policy applied | Task type | Sessions | Complete | Rework | Abandoned | New input | Cached input | Cache created | Output | Reasoning | Provider-reported total | Retries |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const row of report.rows) {
    const policy = row.optimizationApplied ? row.optimizationProfile ?? "validated policy" : "none";
    lines.push(`| ${row.provider} | ${row.mode} | ${policy} | ${row.taskKind} | ${integer(row.sessions)} | ${integer(row.completed)} | ${integer(row.rework)} | ${integer(row.abandoned)} | ${integer(row.inputNew)} | ${integer(row.inputCached)} | ${integer(row.cacheCreated)} | ${integer(row.output)} | ${integer(row.reasoning)} | ${integer(row.reportedTotal)} | ${integer(row.retries)} |`);
  }
  if (report.rows.length === 0) lines.push("| — | — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |");
  lines.push("", "## Matched treatment comparison", "", "> `Token pressure` is new input + cache creation + output + reasoning. It excludes cached reads. `Provider-reported total` is the provider's own final session total when no category breakdown is published. Each metric is compared only with the same provider, task type, and metric. A result becomes `ready` after at least five measured baseline and five measured treatment sessions.", "", "| Provider | Task type | Metric | Policy | Status | Baseline / treatment sessions | Baseline median | Treatment median | Change | Baseline / treatment IQR | Baseline / treatment median duration | Completion |", "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const comparison of report.comparisons) {
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} | ${comparison.metricLabel} | ${comparison.optimizationProfile} | ${comparison.readiness} | ${integer(comparison.baselineSessions)} / ${integer(comparison.treatmentSessions)} | ${integer(comparison.baselineMedianTokenPressure)} | ${integer(comparison.treatmentMedianTokenPressure)} | ${comparison.tokenPressureDeltaPercent.toFixed(1)}% | ${integer(comparison.baselineIqrTokenPressure)} / ${integer(comparison.treatmentIqrTokenPressure)} | ${integer(comparison.baselineMedianDurationSeconds)}s / ${integer(comparison.treatmentMedianDurationSeconds)}s | ${percent(comparison.baselineCompletionRate)} / ${percent(comparison.treatmentCompletionRate)} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | — | — | — | — | — | — | — | — | — |");
  lines.push("", "## Interpretation", "", "- `observe` establishes the personal baseline and does not change CLI behavior.", "- A `balanced` row with a named policy is a real provider-specific treatment. A `balanced` row with `none` means the installed CLI did not advertise a validated flag, so TokenPilot deliberately left it unchanged.", "- A `preliminary` comparison is visible for learning, not a savings claim. Treat a negative `ready` change as a measured reduction.", "- Compare a provider and task type only with its own `observe` rows; cached input is shown separately because it is not equivalent to newly created context.", "- `off` writes no telemetry. `TOKENPILOT_BYPASS=1 <provider>` bypasses TokenPilot immediately.", "");
  return lines.join("\n");
}
