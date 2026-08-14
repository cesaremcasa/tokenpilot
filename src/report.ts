import type { AggregateRow, MeasurementCoverage, SessionSummary, TreatmentComparison } from "./types.js";
import { TelemetryDatabase } from "./database.js";
import type { TokenPilotPaths } from "./paths.js";

export interface Report {
  generatedAt: string;
  since: string;
  rows: AggregateRow[];
  coverage: MeasurementCoverage[];
  comparisons: TreatmentComparison[];
}

export function buildReport(paths: TokenPilotPaths, days: number): Report {
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("--days must be between 1 and 365");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  const database = new TelemetryDatabase(paths);
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

function completionRate(sessions: SessionSummary[]): number | undefined {
  const classified = sessions.filter((session) => session.outcome !== "unknown");
  if (classified.length === 0) return undefined;
  return classified.filter((session) => session.outcome === "completed").length / classified.length;
}

export function treatmentComparisons(summaries: SessionSummary[]): TreatmentComparison[] {
  const baselines = new Map<string, SessionSummary[]>();
  const treatments = new Map<string, SessionSummary[]>();
  for (const session of summaries) {
    const scope = `${session.provider}\u0000${session.taskKind}`;
    if (session.mode === "observe") baselines.set(scope, [...(baselines.get(scope) ?? []), session]);
    if (session.mode === "balanced" && session.optimizationApplied && session.optimizationProfile) {
      const key = `${scope}\u0000${session.optimizationProfile}`;
      treatments.set(key, [...(treatments.get(key) ?? []), session]);
    }
  }
  return [...treatments.entries()].flatMap(([key, treatment]) => {
    const [provider, taskKind, optimizationProfile] = key.split("\u0000") as [TreatmentComparison["provider"], TreatmentComparison["taskKind"], string];
    const baseline = baselines.get(`${provider}\u0000${taskKind}`) ?? [];
    if (baseline.length === 0) return [];
    const baselinePressure = baseline.map(tokenPressure);
    const treatmentPressure = treatment.map(tokenPressure);
    const baselineMedian = median(baselinePressure);
    const treatmentMedian = median(treatmentPressure);
    return [{
      provider,
      taskKind,
      optimizationProfile,
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
    "| Provider | Mode | Policy applied | Task type | Sessions | Complete | Rework | Abandoned | New input | Cached input | Cache created | Output | Reasoning | Retries |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const row of report.rows) {
    const policy = row.optimizationApplied ? row.optimizationProfile ?? "validated policy" : "none";
    lines.push(`| ${row.provider} | ${row.mode} | ${policy} | ${row.taskKind} | ${integer(row.sessions)} | ${integer(row.completed)} | ${integer(row.rework)} | ${integer(row.abandoned)} | ${integer(row.inputNew)} | ${integer(row.inputCached)} | ${integer(row.cacheCreated)} | ${integer(row.output)} | ${integer(row.reasoning)} | ${integer(row.retries)} |`);
  }
  if (report.rows.length === 0) lines.push("| — | — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |");
  lines.push("", "## Matched treatment comparison", "", "> `Token pressure` is new input + cache creation + output + reasoning. It excludes cached reads and is compared only within the same provider and task type. A result becomes `ready` after at least five measured baseline and five measured treatment sessions.", "", "| Provider | Task type | Policy | Status | Baseline / treatment sessions | Baseline median | Treatment median | Change | Baseline / treatment IQR | Baseline / treatment median duration | Completion |", "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const comparison of report.comparisons) {
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} | ${comparison.optimizationProfile} | ${comparison.readiness} | ${integer(comparison.baselineSessions)} / ${integer(comparison.treatmentSessions)} | ${integer(comparison.baselineMedianTokenPressure)} | ${integer(comparison.treatmentMedianTokenPressure)} | ${comparison.tokenPressureDeltaPercent.toFixed(1)}% | ${integer(comparison.baselineIqrTokenPressure)} / ${integer(comparison.treatmentIqrTokenPressure)} | ${integer(comparison.baselineMedianDurationSeconds)}s / ${integer(comparison.treatmentMedianDurationSeconds)}s | ${percent(comparison.baselineCompletionRate)} / ${percent(comparison.treatmentCompletionRate)} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | — | — | — | — | — | — | — | — |");
  lines.push("", "## Interpretation", "", "- `observe` establishes the personal baseline and does not change CLI behavior.", "- A `balanced` row with a named policy is a real provider-specific treatment. A `balanced` row with `none` means the installed CLI did not advertise a validated flag, so TokenPilot deliberately left it unchanged.", "- A `preliminary` comparison is visible for learning, not a savings claim. Treat a negative `ready` change as a measured reduction.", "- Compare a provider and task type only with its own `observe` rows; cached input is shown separately because it is not equivalent to newly created context.", "- `off` writes no telemetry. `TOKENPILOT_BYPASS=1 <provider>` bypasses TokenPilot immediately.", "");
  return lines.join("\n");
}
