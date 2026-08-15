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

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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

function pricingSignature(session: SessionSummary): string {
  const profile = session.pricingProfile;
  if (!profile) return "none";
  // A snapshot, rather than the mutable current configuration, makes old
  // reports reproducible if the user later updates a local price profile.
  return JSON.stringify({ id: profile.id, version: profile.version, rates: profile.rates });
}

function apiEquivalentUsd(session: SessionSummary): number | undefined {
  const profile = session.pricingProfile;
  if (!profile || !session.pricingCompatible || session.measurementBasis !== "token-pressure") return undefined;
  const rates = profile.rates;
  if (rates.reasoningUsdPerMillion !== undefined && session.reasoning === undefined) return undefined;
  const units = 1_000_000;
  return (session.inputNew * rates.inputUsdPerMillion
    + session.inputCached * rates.cachedInputUsdPerMillion
    + session.cacheCreated * rates.cacheCreationUsdPerMillion
    + session.output * rates.outputUsdPerMillion
    + session.reasoning * (rates.reasoningUsdPerMillion ?? 0)) / units;
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
    const profile = session.comparisonProfile ?? (session.mode === "balanced" ? session.optimizationProfile : undefined);
    if (!profile) continue;
    const scope = `${session.provider}\u0000${session.taskKind}\u0000${basis}\u0000${profile}\u0000${pricingSignature(session)}`;
    if (session.mode === "observe") baselines.set(scope, [...(baselines.get(scope) ?? []), session]);
    if (session.mode === "balanced" && session.optimizationApplied && session.optimizationProfile) {
      treatments.set(scope, [...(treatments.get(scope) ?? []), session]);
    }
  }
  return [...treatments.entries()].flatMap(([key, treatment]) => {
    const [provider, taskKind, basis, optimizationProfile] = key.split("\u0000") as [TreatmentComparison["provider"], TreatmentComparison["taskKind"], NonNullable<SessionSummary["measurementBasis"]>, string];
    const baseline = baselines.get(key) ?? [];
    if (baseline.length === 0) return [];
    const baselinePressure = baseline.map(measurementValue).filter((value): value is number => value !== undefined);
    const treatmentPressure = treatment.map(measurementValue).filter((value): value is number => value !== undefined);
    const baselineMedian = median(baselinePressure);
    const treatmentMedian = median(treatmentPressure);
    // There is no provider-side counterfactual for a live treated task. The
    // closest honest token-only estimate is the matched observe median applied
    // to the number of treatment sessions, minus the tokens actually measured
    // for those treatment sessions. Cached reads remain outside this measure.
    const baselineExpectedTreatmentTokens = baselineMedian * treatmentPressure.length;
    const treatmentRecordedTokens = sum(treatmentPressure);
    const estimatedTokensAvoided = baselineExpectedTreatmentTokens - treatmentRecordedTokens;
    const tokenReductionPercent = baselineMedian === 0 ? 0 : ((baselineMedian - treatmentMedian) / baselineMedian) * 100;
    const baselineMedianDurationSeconds = median(baseline.map((session) => session.durationSeconds));
    const treatmentMedianDurationSeconds = median(treatment.map((session) => session.durationSeconds));
    const latencyDeltaSeconds = treatmentMedianDurationSeconds - baselineMedianDurationSeconds;
    const latencyDeltaPercent = baselineMedianDurationSeconds === 0 ? 0 : (latencyDeltaSeconds / baselineMedianDurationSeconds) * 100;
    const latencyResult: TreatmentComparison["latencyResult"] = latencyDeltaSeconds < 0 ? "faster" : latencyDeltaSeconds > 0 ? "slower" : "unchanged";
    // Unknown work can be useful for personal monitoring, but it mixes task
    // shapes. Benchmarks are intentionally kept out of real-work claims.
    const classifiedWork = taskKind !== "unknown" && taskKind !== "benchmark";
    const readiness = classifiedWork && baseline.length >= 5 && treatment.length >= 5 ? "ready" as const : "preliminary" as const;
    const tokenResult: TreatmentComparison["tokenResult"] = readiness === "preliminary"
      ? "preliminary"
      : estimatedTokensAvoided > 0 ? "measured-reduction" : "no-reduction";
    const baselineUsd = baseline.map(apiEquivalentUsd);
    const treatmentUsd = treatment.map(apiEquivalentUsd);
    const hasComparableUsd = baselineUsd.every((value): value is number => value !== undefined)
      && treatmentUsd.every((value): value is number => value !== undefined);
    const pricedBaselineUsd = hasComparableUsd ? baselineUsd.map((value) => value as number) : [];
    const pricedTreatmentUsd = hasComparableUsd ? treatmentUsd.map((value) => value as number) : [];
    const baselineMedianUsd = hasComparableUsd ? median(pricedBaselineUsd) : undefined;
    const treatmentRecordedUsd = hasComparableUsd ? sum(pricedTreatmentUsd) : undefined;
    const baselineExpectedUsd = baselineMedianUsd === undefined ? undefined : baselineMedianUsd * treatment.length;
    const estimatedUsdAvoided = baselineExpectedUsd === undefined || treatmentRecordedUsd === undefined
      ? undefined
      : baselineExpectedUsd - treatmentRecordedUsd;
    const usdReductionPercent = baselineMedianUsd === undefined || baselineMedianUsd === 0 || pricedTreatmentUsd.length === 0
      ? undefined
      : ((baselineMedianUsd - median(pricedTreatmentUsd)) / baselineMedianUsd) * 100;
    const attachedProfile = treatment[0].pricingProfile;
    return [{
      provider,
      taskKind,
      optimizationProfile,
      metricLabel: metricLabel(treatment[0]),
      baselineSessions: baseline.length,
      treatmentSessions: treatment.length,
      baselineMedianTokenPressure: baselineMedian,
      treatmentMedianTokenPressure: treatmentMedian,
      baselineExpectedTreatmentTokens,
      treatmentRecordedTokens,
      estimatedTokensAvoided,
      tokenReductionPercent,
      tokenPressureDeltaPercent: baselineMedian === 0 ? 0 : ((treatmentMedian - baselineMedian) / baselineMedian) * 100,
      baselineIqrTokenPressure: interquartileRange(baselinePressure),
      treatmentIqrTokenPressure: interquartileRange(treatmentPressure),
      baselineMedianDurationSeconds,
      treatmentMedianDurationSeconds,
      latencyDeltaSeconds,
      latencyDeltaPercent,
      latencyResult,
      baselineCompletionRate: completionRate(baseline),
      treatmentCompletionRate: completionRate(treatment),
      pricingProfile: attachedProfile ? {
        id: attachedProfile.id,
        version: attachedProfile.version,
        label: attachedProfile.label,
        currency: attachedProfile.currency
      } : undefined,
      baselineExpectedUsd,
      treatmentRecordedUsd,
      estimatedUsdAvoided,
      usdReductionPercent,
      readiness,
      tokenResult
    }];
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.taskKind.localeCompare(b.taskKind));
}

function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
}

function reduction(value: number): string {
  return value >= 0 ? `${value.toFixed(1)}% reduction` : `${Math.abs(value).toFixed(1)}% increase`;
}

function usd(value: number | undefined): string {
  return value === undefined ? "—" : `$${value.toFixed(6)}`;
}

function latency(comparison: TreatmentComparison): string {
  const direction = comparison.latencyResult === "unchanged" ? "unchanged" : comparison.latencyResult;
  const seconds = comparison.latencyDeltaSeconds > 0 ? `+${integer(comparison.latencyDeltaSeconds)}s` : `${integer(comparison.latencyDeltaSeconds)}s`;
  return `${seconds} (${comparison.latencyDeltaPercent > 0 ? "+" : ""}${comparison.latencyDeltaPercent.toFixed(1)}%; ${direction})`;
}

export function reportMarkdown(report: Report): string {
  const lines = [
    "# TokenPilot — Personal telemetry report",
    "",
    `Generated: ${report.generatedAt}`,
    `Window: last seven days (starts ${report.since})`,
    "",
    "> This report contains aggregate numeric telemetry only. Do not compare raw token totals or API-equivalent USD across providers.",
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
  lines.push("", "## Reduction and latency summary", "", "> `Baseline expected` is the matched observe median multiplied by the treatment-session count: what those treated sessions would be expected to use without the policy. `Actual tokens used` is what the provider reported for those treatment sessions. `Tokens avoided` is baseline minus actual: a counterfactual estimate, not tokens blocked by the provider. Latency is end-to-end local CLI duration; a positive latency change means slower.", "", "| Provider | Task type | Policy | Result | Baseline expected | Actual tokens used | Tokens avoided | Token reduction | Median latency | Latency change |", "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const comparison of report.comparisons) {
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} | ${comparison.optimizationProfile} | ${comparison.tokenResult} | ${integer(comparison.baselineExpectedTreatmentTokens)} | ${integer(comparison.treatmentRecordedTokens)} | ${integer(comparison.estimatedTokensAvoided)} | ${reduction(comparison.tokenReductionPercent)} | ${integer(comparison.baselineMedianDurationSeconds)}s → ${integer(comparison.treatmentMedianDurationSeconds)}s | ${latency(comparison)} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | — | — | — | — | — | — | — |");
  lines.push("", "## API-equivalent USD", "", "> API-equivalent USD uses only the local price-profile snapshot attached before each session started, and only category-level metrics (new input, cached input, cache creation, output, and reasoning when priced). It is **not a provider bill**. Personal subscriptions must never be presented as money actually saved.", "", "| Provider | Task type | Price profile | Expected without policy | Used in treatment | Equivalent avoided | Equivalent reduction |", "| --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const comparison of report.comparisons) {
    const profile = comparison.pricingProfile ? `${comparison.pricingProfile.label} (${comparison.pricingProfile.id}@${comparison.pricingProfile.version})` : "not configured / incompatible metrics";
    const percentage = comparison.usdReductionPercent === undefined ? "—" : reduction(comparison.usdReductionPercent);
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} | ${profile} | ${usd(comparison.baselineExpectedUsd)} | ${usd(comparison.treatmentRecordedUsd)} | ${usd(comparison.estimatedUsdAvoided)} | ${percentage} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | — | — | — | — |");
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
  lines.push("", "## Matched treatment comparison", "", "> `Token pressure` is new input + cache creation + output + reasoning. It excludes cached reads. `Provider-reported total` is the provider's own final session total when no category breakdown is published. Each metric is compared only with the same provider, task type, metric, policy version, and price-profile snapshot. A result becomes `ready` only for classified non-benchmark work after at least five measured baseline and five measured treatment sessions.", "", "| Provider | Task type | Metric | Policy | Status | Baseline / treatment sessions | Baseline median | Treatment median | Change | Baseline / treatment IQR | Baseline / treatment median duration | Completion |", "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const comparison of report.comparisons) {
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} | ${comparison.metricLabel} | ${comparison.optimizationProfile} | ${comparison.readiness} | ${integer(comparison.baselineSessions)} / ${integer(comparison.treatmentSessions)} | ${integer(comparison.baselineMedianTokenPressure)} | ${integer(comparison.treatmentMedianTokenPressure)} | ${comparison.tokenPressureDeltaPercent.toFixed(1)}% | ${integer(comparison.baselineIqrTokenPressure)} / ${integer(comparison.treatmentIqrTokenPressure)} | ${integer(comparison.baselineMedianDurationSeconds)}s / ${integer(comparison.treatmentMedianDurationSeconds)}s | ${percent(comparison.baselineCompletionRate)} / ${percent(comparison.treatmentCompletionRate)} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | — | — | — | — | — | — | — | — | — |");
  lines.push("", "## Estimated token avoidance", "", "> This is a token counterfactual estimate. For each matched treatment group: `(matched observe median × treatment sessions) − treatment tokens actually recorded`. A negative number means the policy used more tokens. API-equivalent USD, when present above, uses the same counterfactual and is not a provider invoice.", "", "| Provider | Task type | Metric | Policy | Token result | Expected without policy | Treatment tokens recorded | Estimated tokens avoided |", "| --- | --- | --- | --- | --- | ---: | ---: | ---: |");
  for (const comparison of report.comparisons) {
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} | ${comparison.metricLabel} | ${comparison.optimizationProfile} | ${comparison.tokenResult} | ${integer(comparison.baselineExpectedTreatmentTokens)} | ${integer(comparison.treatmentRecordedTokens)} | ${integer(comparison.estimatedTokensAvoided)} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | — | — | — | — | — |");
  lines.push("", "## Interpretation", "", "- `observe` establishes the personal baseline and does not change CLI behavior.", "- A `balanced` row with a named policy is a real provider-specific treatment. A `balanced` row with `none` means the installed CLI did not advertise a validated flag, so TokenPilot deliberately left it unchanged.", "- `estimated tokens avoided` is calculated only against matched sessions from the same provider, task type, metric, policy version, and price-profile snapshot. It is not a cross-provider total.", "- A `preliminary` token result is visible for learning, not a savings claim. `unknown` and `benchmark` work always remain preliminary. `measured-reduction` requires a ready classified-work comparison with positive estimated tokens avoided; `no-reduction` is shown when a ready treatment does not lower tokens.", "- API-equivalent USD is optional and reproducible from the session's price snapshot. It is a modeled API value, never a subscription saving or real billing figure.", "- Compare a provider and task type only with its own `observe` rows; cached input is shown separately because it is not equivalent to newly created context.", "- `off` writes no telemetry. `TOKENPILOT_BYPASS=1 <provider>` bypasses TokenPilot immediately.", "");
  return lines.join("\n");
}
