import fs from "node:fs";
import type { AggregateRow, AuditableSession, MeasurementCoverage, Provider, QualityObservation, SessionSummary, TreatmentComparison } from "./types.js";
import { TelemetryDatabase } from "./database.js";
import { assertSafeStateFile, hasSafePrivateDirectory, type TokenPilotPaths } from "./paths.js";

export type ReportView = "summary" | "detail" | "diagnostics";

export interface Report {
  generatedAt: string;
  since: string;
  rows: AggregateRow[];
  coverage: MeasurementCoverage[];
  comparisons: TreatmentComparison[];
  sessions?: AuditableSession[];
}

/**
 * Limit an already-built read-only report to one provider. Skills use this so
 * each host reports only the experiment it can actually run. An explicit
 * zero-coverage row keeps the empty state clear without inventing telemetry.
 */
export function filterReportByProvider(report: Report, provider: Provider): Report {
  const coverage = report.coverage.filter((row) => row.provider === provider);
  return {
    ...report,
    rows: report.rows.filter((row) => row.provider === provider),
    coverage: coverage.length > 0 ? coverage : [{ provider, sessions: 0, measuredSessions: 0, unavailableSessions: 0 }],
    comparisons: report.comparisons.filter((comparison) => comparison.provider === provider),
    sessions: report.sessions?.filter((session) => session.provider === provider)
  };
}

const CACHE_SHIFT_TOTAL_FLAT_PERCENT = 0.02;
const CACHE_SHIFT_MIN_CACHE_RECOVERY = 0.5;
const MIN_VALIDATED_SESSIONS_PER_ARM = 3;

function emptyReport(since: string): Report {
  return { generatedAt: new Date().toISOString(), since, rows: [], coverage: [], comparisons: [], sessions: [] };
}

const ALL_RECORDED_DATA_SINCE = "1970-01-01T00:00:00.000Z";

function usesLegacyWalDatabase(databaseFile: string): boolean {
  const descriptor = fs.openSync(databaseFile, "r");
  try {
    const header = Buffer.alloc(20);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    return bytesRead === header.length && (header[18] === 2 || header[19] === 2);
  } finally {
    fs.closeSync(descriptor);
  }
}

function buildReportSince(paths: TokenPilotPaths, since: string): Report {
  if (!fs.existsSync(paths.databaseFile)) return emptyReport(since);
  if (!hasSafePrivateDirectory(paths, paths.dataDir)) throw new Error("TokenPilot telemetry directory is unsafe");
  assertSafeStateFile(paths, paths.databaseFile);
  if (usesLegacyWalDatabase(paths.databaseFile)) {
    throw new Error("TokenPilot telemetry uses a legacy WAL database; start one personal session to migrate it before requesting a read-only report");
  }
  const database = new TelemetryDatabase(paths, { readOnly: true });
  try {
    const summaries = database.sessionSummariesSince(since);
    const sessions = database.auditableSessionsSince(since);
    const comparisons = treatmentComparisons(summaries);
    appendCoverageStates(comparisons, sessions);
    return {
      generatedAt: new Date().toISOString(),
      since,
      rows: database.aggregateSince(since),
      coverage: database.measurementCoverageSince(since),
      comparisons,
      sessions
    };
  } finally {
    database.close();
  }
}

/** Read-only report construction. It never creates, migrates, or journals telemetry. */
export function buildReport(paths: TokenPilotPaths, days: number): Report {
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("--days must be between 1 and 365");
  return buildReportSince(paths, new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString());
}

/** Skill summaries use the latest comparable measurement, regardless of rolling-window boundaries. */
export function buildLatestSummaryReport(paths: TokenPilotPaths): Report {
  return buildReportSince(paths, ALL_RECORDED_DATA_SINCE);
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

function latestStartedAt(sessions: SessionSummary[]): string | undefined {
  return sessions.map((session) => session.startedAt).filter((value): value is string => value !== undefined).sort().at(-1);
}

function tokenPressure(session: SessionSummary): number {
  return session.inputNew + session.cacheCreated + session.output + session.reasoning;
}

function hasCompleteCategories(session: SessionSummary): boolean {
  return session.categoryMetricsComplete !== false;
}

function categoryTotal(session: SessionSummary): number | undefined {
  if (!hasCompleteCategories(session)) return undefined;
  return session.inputNew + session.inputCached + session.cacheCreated + session.output + session.reasoning;
}

function completeTotal(session: SessionSummary): { value: number; source: TreatmentComparison["totalSource"] } | undefined {
  if (session.reportedTotal !== undefined && session.reportedTotalIncludesCachedInput === true) {
    return { value: session.reportedTotal, source: "provider-reported total" };
  }
  const total = categoryTotal(session);
  return total === undefined ? undefined : { value: total, source: "category total" };
}

function pricingSignature(session: SessionSummary): string {
  const profile = session.pricingProfile;
  return profile ? JSON.stringify({ id: profile.id, version: profile.version, rates: profile.rates }) : "none";
}

function apiEquivalentUsd(session: SessionSummary): number | undefined {
  const profile = session.pricingProfile;
  if (!profile || !session.pricingCompatible || !hasCompleteCategories(session)) return undefined;
  const rates = profile.rates;
  const units = 1_000_000;
  return (session.inputNew * rates.inputUsdPerMillion
    + session.inputCached * rates.cachedInputUsdPerMillion
    + session.cacheCreated * rates.cacheCreationUsdPerMillion
    + session.output * rates.outputUsdPerMillion
    + session.reasoning * (rates.reasoningUsdPerMillion ?? 0)) / units;
}

type QualityAssessment = Pick<TreatmentComparison, "qualityObservation" | "qualityEvidence" | "baselineCompletionRate" | "treatmentCompletionRate" | "baselineReworkRate" | "treatmentReworkRate" | "baselineAbandonmentRate" | "treatmentAbandonmentRate">;

function outcomeRate(sessions: SessionSummary[], outcome: "completed" | "rework" | "abandoned"): number | undefined {
  const classified = sessions.filter((session) => session.outcome !== "unknown");
  return classified.length === 0 ? undefined : classified.filter((session) => session.outcome === outcome).length / classified.length;
}

/**
 * Quality is deliberately derived from the closed outcome vocabulary only.
 * Unknown outcomes fail open to an unverified result; they never become a
 * successful or failed quality claim and never expose provider content.
 */
function qualityAssessment(baseline: SessionSummary[], treatment: SessionSummary[]): QualityAssessment {
  const knownOutcomes = new Set(["completed", "rework", "abandoned"]);
  const baselineCompletionRate = outcomeRate(baseline, "completed");
  const treatmentCompletionRate = outcomeRate(treatment, "completed");
  const baselineReworkRate = outcomeRate(baseline, "rework");
  const treatmentReworkRate = outcomeRate(treatment, "rework");
  const baselineAbandonmentRate = outcomeRate(baseline, "abandoned");
  const treatmentAbandonmentRate = outcomeRate(treatment, "abandoned");
  if (![...baseline, ...treatment].every((session) => knownOutcomes.has(session.outcome))) {
    return {
      qualityObservation: "unknown",
      qualityEvidence: "observed-outcomes",
      baselineCompletionRate,
      treatmentCompletionRate,
      baselineReworkRate,
      treatmentReworkRate,
      baselineAbandonmentRate,
      treatmentAbandonmentRate
    };
  }
  if ([baselineCompletionRate, treatmentCompletionRate, baselineReworkRate, treatmentReworkRate, baselineAbandonmentRate, treatmentAbandonmentRate]
    .some((value) => value === undefined)) {
    return {
      qualityObservation: "unknown",
      qualityEvidence: "observed-outcomes",
      baselineCompletionRate,
      treatmentCompletionRate,
      baselineReworkRate,
      treatmentReworkRate,
      baselineAbandonmentRate,
      treatmentAbandonmentRate
    };
  }
  const observedNotDegraded = treatmentCompletionRate! >= baselineCompletionRate!
    && treatmentReworkRate! <= baselineReworkRate!
    && treatmentAbandonmentRate! <= baselineAbandonmentRate!;
  return {
    qualityObservation: observedNotDegraded ? "observed-not-degraded" : "degraded",
    qualityEvidence: "observed-outcomes",
    baselineCompletionRate,
    treatmentCompletionRate,
    baselineReworkRate,
    treatmentReworkRate,
    baselineAbandonmentRate,
    treatmentAbandonmentRate
  };
}

function cacheShift(baseline: SessionSummary[], treatment: SessionSummary[], baselineTotal: number, treatmentTotal: number): boolean {
  if (baselineTotal <= 0) return false;
  const newChange = median(treatment.map((session) => session.inputNew)) - median(baseline.map((session) => session.inputNew));
  const cacheChange = median(treatment.map((session) => session.inputCached)) - median(baseline.map((session) => session.inputCached));
  const totalChange = Math.abs(treatmentTotal - baselineTotal) / baselineTotal;
  const categoriesMovedInOppositeDirections = newChange * cacheChange < 0;
  const cacheMovementExplainsNewMovement = Math.abs(cacheChange) >= Math.abs(newChange) * CACHE_SHIFT_MIN_CACHE_RECOVERY;
  return categoriesMovedInOppositeDirections && cacheMovementExplainsNewMovement && totalChange < CACHE_SHIFT_TOTAL_FLAT_PERCENT;
}

/**
 * Build only within-provider, cache-aware matched comparisons. A total is
 * provider-published only when cache semantics are verified; otherwise a
 * complete category total is used, which keeps every provider eligible for a
 * matched 3+3 validation without estimating unavailable counters.
 */
export function treatmentComparisons(summaries: SessionSummary[]): TreatmentComparison[] {
  const treatments = new Map<string, SessionSummary[]>();
  for (const session of summaries) {
    const profile = session.comparisonProfile ?? (session.mode === "balanced" || session.mode === "reduce" ? session.optimizationProfile : undefined);
    if (!profile) continue;
    if ((session.mode === "balanced" || session.mode === "reduce") && session.optimizationApplied && session.optimizationProfile) {
      const scope = `${session.provider}\u0000${session.taskKind}\u0000${profile}\u0000${pricingSignature(session)}`;
      treatments.set(scope, [...(treatments.get(scope) ?? []), session]);
    }
  }

  return [...treatments.entries()].flatMap(([key, treatment]) => {
    const [provider, taskKind, optimizationProfile, priceSignature] = key.split("\u0000") as [TreatmentComparison["provider"], TreatmentComparison["taskKind"], string, string];
    const sameProviderTask = summaries.filter((session) => session.mode === "observe" && session.provider === provider && session.taskKind === taskKind);
    const samePolicy = sameProviderTask.filter((session) => session.comparisonProfile === optimizationProfile);
    const baseline = samePolicy.filter((session) => pricingSignature(session) === priceSignature);
    const treatmentTotalsWithSource = treatment.map(completeTotal);
    if (treatmentTotalsWithSource.some((total) => total === undefined)) {
      return [stateComparison(provider, taskKind, optimizationProfile, "limited", "provider total missing or unverified; category total unavailable", baseline, treatment)];
    }
    if (baseline.length === 0) {
      const treatmentSources = new Set(treatmentTotalsWithSource.map((total) => total!.source));
      const treatmentSource = treatmentSources.size === 1 ? [...treatmentSources][0] : "none";
      const reason = samePolicy.length > 0
        ? "price snapshot split: no baseline has the treatment price snapshot"
        : sameProviderTask.length > 0
          ? "policy split: no baseline has the treatment policy"
          : "no comparable baseline for provider and task type";
      return [stateComparison(provider, taskKind, optimizationProfile, "incomparable", reason, [], treatment, treatmentSource)];
    }
    const baselineTotalsWithSource = baseline.map(completeTotal);
    if (baselineTotalsWithSource.some((total) => total === undefined)) {
      return [stateComparison(provider, taskKind, optimizationProfile, "limited", "provider total missing or unverified; category total unavailable", baseline, treatment)];
    }
    const sources = new Set([...baselineTotalsWithSource, ...treatmentTotalsWithSource].map((total) => total!.source));
    if (sources.size !== 1) {
      return [stateComparison(provider, taskKind, optimizationProfile, "incomparable", "mixed metric bases: provider-reported total and category total cannot be compared", baseline, treatment)];
    }
    const totalSource = [...sources][0];
    const baselineTotals = baseline.map((session) => completeTotal(session)?.value).filter((value): value is number => value !== undefined);
    const treatmentTotals = treatment.map((session) => completeTotal(session)?.value).filter((value): value is number => value !== undefined);
    if (baselineTotals.length !== baseline.length || treatmentTotals.length !== treatment.length) {
      return [stateComparison(provider, taskKind, optimizationProfile, "limited", "complete comparable total unavailable", baseline, treatment)];
    }
    const baselineMedianTotal = median(baselineTotals);
    const treatmentMedianTotal = median(treatmentTotals);
    const baselineExpectedTreatmentTokens = baselineMedianTotal * treatment.length;
    const treatmentRecordedTokens = sum(treatmentTotals);
    const estimatedTokensAvoided = baselineExpectedTreatmentTokens - treatmentRecordedTokens;
    const tokenReductionPercent = baselineMedianTotal === 0 ? 0 : ((baselineMedianTotal - treatmentMedianTotal) / baselineMedianTotal) * 100;
    const isCacheShift = cacheShift(baseline, treatment, baselineMedianTotal, treatmentMedianTotal);
    const quality = qualityAssessment(baseline, treatment);
    const classifiedWork = taskKind !== "unknown" && taskKind !== "benchmark";
    const readiness = classifiedWork && baseline.length >= MIN_VALIDATED_SESSIONS_PER_ARM && treatment.length >= MIN_VALIDATED_SESSIONS_PER_ARM ? "ready" as const : "preliminary" as const;
    const tokenResult: TreatmentComparison["tokenResult"] = isCacheShift
      ? "cache-shift"
      : readiness === "ready" && quality.qualityEvidence === "formal-equivalence" && estimatedTokensAvoided > 0 && tokenReductionPercent > 0 ? "validated-reduction" : "preliminary-signal";
    const baselineUsd = baseline.map(apiEquivalentUsd);
    const treatmentUsd = treatment.map(apiEquivalentUsd);
    const hasComparableUsd = baselineUsd.every((value): value is number => value !== undefined)
      && treatmentUsd.every((value): value is number => value !== undefined);
    const baselineMedianUsd = hasComparableUsd ? median(baselineUsd) : undefined;
    const treatmentRecordedUsd = hasComparableUsd ? sum(treatmentUsd) : undefined;
    const baselineExpectedUsd = baselineMedianUsd === undefined ? undefined : baselineMedianUsd * treatment.length;
    const rawEstimatedUsdAvoided = baselineExpectedUsd === undefined || treatmentRecordedUsd === undefined ? undefined : baselineExpectedUsd - treatmentRecordedUsd;
    const usdReductionPercent = baselineMedianUsd === undefined || baselineMedianUsd === 0 || !hasComparableUsd ? undefined : ((baselineMedianUsd - median(treatmentUsd)) / baselineMedianUsd) * 100;
    const numberMedian = (sessions: SessionSummary[], key: keyof Pick<SessionSummary, "inputNew" | "inputCached" | "cacheCreated" | "output" | "reasoning">) => median(sessions.map((session) => session[key]));
    const baselinePressure = baseline.map(tokenPressure);
    const treatmentPressure = treatment.map(tokenPressure);
    const baselineMedianDurationSeconds = median(baseline.map((session) => session.durationSeconds));
    const treatmentMedianDurationSeconds = median(treatment.map((session) => session.durationSeconds));
    const latencyDeltaSeconds = treatmentMedianDurationSeconds - baselineMedianDurationSeconds;
    const latencyDeltaPercent = baselineMedianDurationSeconds === 0 ? 0 : (latencyDeltaSeconds / baselineMedianDurationSeconds) * 100;
    const latencyResult: TreatmentComparison["latencyResult"] = latencyDeltaSeconds < 0 ? "faster" : latencyDeltaSeconds > 0 ? "slower" : "unchanged";
    const attachedProfile = treatment[0].pricingProfile;
    const emitsEconomy = tokenResult === "validated-reduction";
    return [{
      provider,
      taskKind,
      optimizationProfile,
      metricLabel: totalSource,
      totalSource,
      baselineSessions: baseline.length,
      treatmentSessions: treatment.length,
      latestTreatmentAt: latestStartedAt(treatment),
      baselineMedianTokenPressure: median(baselinePressure),
      treatmentMedianTokenPressure: median(treatmentPressure),
      baselineMedianInputNew: numberMedian(baseline, "inputNew"),
      treatmentMedianInputNew: numberMedian(treatment, "inputNew"),
      baselineMedianCachedInput: numberMedian(baseline, "inputCached"),
      treatmentMedianCachedInput: numberMedian(treatment, "inputCached"),
      baselineMedianCacheCreated: numberMedian(baseline, "cacheCreated"),
      treatmentMedianCacheCreated: numberMedian(treatment, "cacheCreated"),
      baselineMedianOutput: numberMedian(baseline, "output"),
      treatmentMedianOutput: numberMedian(treatment, "output"),
      baselineMedianReasoning: numberMedian(baseline, "reasoning"),
      treatmentMedianReasoning: numberMedian(treatment, "reasoning"),
      baselineMedianComparableTotal: baselineMedianTotal,
      treatmentMedianComparableTotal: treatmentMedianTotal,
      // Token comparisons remain visible as observed cache-aware measurements.
      // Formal quality evidence gates financial/economy claims, not the raw
      // percentage the provider skill exists to report.
      baselineExpectedTreatmentTokens,
      treatmentRecordedTokens,
      estimatedTokensAvoided: isCacheShift ? undefined : estimatedTokensAvoided,
      tokenReductionPercent: isCacheShift ? undefined : tokenReductionPercent,
      tokenPressureDeltaPercent: isCacheShift ? undefined : median(baselinePressure) === 0 ? 0 : ((median(treatmentPressure) - median(baselinePressure)) / median(baselinePressure)) * 100,
      baselineIqrTokenPressure: interquartileRange(baselineTotals),
      treatmentIqrTokenPressure: interquartileRange(treatmentTotals),
      baselineMedianDurationSeconds,
      treatmentMedianDurationSeconds,
      latencyDeltaSeconds,
      latencyDeltaPercent,
      latencyResult,
      ...quality,
      pricingProfile: attachedProfile ? { id: attachedProfile.id, version: attachedProfile.version, label: attachedProfile.label, currency: attachedProfile.currency } : undefined,
      baselineExpectedUsd: emitsEconomy ? baselineExpectedUsd : undefined,
      treatmentRecordedUsd: emitsEconomy ? treatmentRecordedUsd : undefined,
      estimatedUsdAvoided: emitsEconomy ? rawEstimatedUsdAvoided : undefined,
      usdReductionPercent: emitsEconomy ? usdReductionPercent : undefined,
      readiness,
      tokenResult,
      reason: isCacheShift
        ? "new input moved into cache reads while the complete total stayed flat"
        : tokenResult === "validated-reduction"
          ? undefined
          : quality.qualityObservation === "unknown"
            ? "quality observation unavailable; classify every matched session as completed, rework, or abandoned"
            : quality.qualityObservation === "degraded"
              ? "observed quality degraded; treatment outcomes are worse than baseline"
              : "sample is directional; formal quality evidence is unavailable",
      baselineSessionIds: baseline.map((session) => session.id),
      treatmentSessionIds: treatment.map((session) => session.id)
    }];
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.taskKind.localeCompare(b.taskKind));
}

function stateComparison(
  provider: Provider,
  taskKind: TreatmentComparison["taskKind"],
  optimizationProfile: string,
  tokenResult: Extract<TreatmentComparison["tokenResult"], "limited" | "incomparable">,
  reason: string,
  baseline: SessionSummary[] = [],
  treatment: SessionSummary[] = [],
  totalSource: TreatmentComparison["totalSource"] = "none"
): TreatmentComparison {
  return {
    provider,
    taskKind,
    optimizationProfile,
    metricLabel: totalSource,
    totalSource,
    baselineSessions: baseline.length,
    treatmentSessions: treatment.length,
    latestTreatmentAt: latestStartedAt(treatment),
    readiness: "unavailable",
    tokenResult,
    qualityObservation: "unknown",
    qualityEvidence: "observed-outcomes",
    reason,
    baselineSessionIds: baseline.map((session) => session.id),
    treatmentSessionIds: treatment.map((session) => session.id)
  };
}

function appendCoverageStates(comparisons: TreatmentComparison[], sessions: AuditableSession[]): void {
  for (const provider of [...new Set(sessions.map((session) => session.provider))]) {
    if (comparisons.some((comparison) => comparison.provider === provider)) continue;
    const providerSessions = sessions.filter((session) => session.provider === provider);
    const measured = providerSessions.filter((session) => session.measurement === "measured");
    const unavailable = providerSessions.filter((session) => session.measurement === "unavailable");
    if (measured.length === 0) {
      const reasons = [...new Set(unavailable.map((session) => session.unavailableReason ?? "no-correlated-counters"))].join(", ");
      comparisons.push({
        ...stateComparison(provider, "unknown", "none", "limited", `no measured session; ${reasons}`),
        treatmentSessionIds: unavailable.map((session) => session.id)
      });
    } else {
      comparisons.push({
        ...stateComparison(provider, "unknown", "none", "incomparable", "measured sessions exist, but no matched baseline and treatment cohort exists"),
        baselineSessionIds: measured.map((session) => session.id)
      });
    }
  }
  comparisons.sort((a, b) => a.provider.localeCompare(b.provider) || a.taskKind.localeCompare(b.taskKind));
}

function usd(value: number | undefined): string {
  return value === undefined ? "—" : `$${value.toFixed(6)}`;
}

function latency(comparison: TreatmentComparison): string {
  if (comparison.latencyDeltaSeconds === undefined || comparison.latencyDeltaPercent === undefined || comparison.latencyResult === undefined) return "—";
  const seconds = comparison.latencyDeltaSeconds > 0 ? `+${integer(comparison.latencyDeltaSeconds)}s` : `${integer(comparison.latencyDeltaSeconds)}s`;
  return `${seconds} (${comparison.latencyDeltaPercent > 0 ? "+" : ""}${comparison.latencyDeltaPercent.toFixed(1)}%; ${comparison.latencyResult})`;
}

function qualityObservation(comparison: TreatmentComparison): QualityObservation {
  if (comparison.qualityObservation) return comparison.qualityObservation;
  if (comparison.qualityResult === "equivalent") return "observed-not-degraded";
  return comparison.qualityResult ?? "unknown";
}

function comparisonResult(comparison: TreatmentComparison): string {
  if (comparison.tokenResult === "limited") return `limited measurement — ${comparison.reason ?? "numeric total unavailable"}`;
  if (comparison.tokenResult === "incomparable") return `no comparable base — ${comparison.reason ?? "cohorts do not match"}`;
  if (comparison.tokenResult === "cache-shift") return "cache-shift — no reduction emitted";
  const quality = qualityObservation(comparison) === "observed-not-degraded"
    ? "quality observed not degraded"
    : qualityObservation(comparison) === "degraded" ? "quality degraded" : "quality unverified";
  if (comparison.tokenResult === "validated-reduction") return `${(comparison.tokenReductionPercent ?? 0).toFixed(1)}% validated cache-aware reduction (${quality})`;
  const percent = comparison.tokenReductionPercent === undefined ? "" : `${comparison.tokenReductionPercent.toFixed(1)}% `;
  return `${percent}measured cache-aware variation — preliminary, not an economy (${quality})`;
}

function categoryLine(comparison: TreatmentComparison): string {
  if (comparison.baselineMedianInputNew === undefined || comparison.treatmentMedianInputNew === undefined || comparison.baselineMedianComparableTotal === undefined || comparison.treatmentMedianComparableTotal === undefined) return "—";
  return `new ${integer(comparison.baselineMedianInputNew)}→${integer(comparison.treatmentMedianInputNew)}; cached ${integer(comparison.baselineMedianCachedInput!)}→${integer(comparison.treatmentMedianCachedInput!)}; created ${integer(comparison.baselineMedianCacheCreated!)}→${integer(comparison.treatmentMedianCacheCreated!)}; pressure ${integer(comparison.baselineMedianTokenPressure!)}→${integer(comparison.treatmentMedianTokenPressure!)}; total ${integer(comparison.baselineMedianComparableTotal)}→${integer(comparison.treatmentMedianComparableTotal)}`;
}

function summaryComparison(comparisons: TreatmentComparison[]): TreatmentComparison | undefined {
  const measurable = comparisons.filter((comparison) => (
    comparison.tokenReductionPercent !== undefined || comparison.tokenResult === "cache-shift"
  ));
  const current = measurable.length > 0 ? measurable : comparisons;
  const taskRank = (comparison: TreatmentComparison) => comparison.taskKind === "unknown" ? 0 : comparison.taskKind === "benchmark" ? 1 : 2;
  const conservativeRank = (comparison: TreatmentComparison) => ({
    "validated-reduction": 0,
    "preliminary-signal": 1,
    incomparable: 2,
    limited: 3,
    "cache-shift": 4
  })[comparison.tokenResult];
  return [...current].sort((left, right) => {
    const time = (left.latestTreatmentAt ?? "").localeCompare(right.latestTreatmentAt ?? "");
    if (time !== 0) return time;
    const profile = left.optimizationProfile.localeCompare(right.optimizationProfile, undefined, { numeric: true });
    if (profile !== 0) return profile;
    return taskRank(left) - taskRank(right) || conservativeRank(left) - conservativeRank(right);
  }).at(-1);
}

function providerName(provider: Provider): string {
  return provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider === "grok" ? "Grok" : "Kimi";
}

const SCOREBOARD_MISSING = "sem comparação cache-aware medida";

function scoreboardPercent(value: number): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1).replace(".", ",")}`;
  return value < 0 ? `${text}% a mais` : `${text}% a menos`;
}

function providerScore(report: Report, provider: Provider): string {
  const scoped = filterReportByProvider(report, provider);
  const comparison = summaryComparison(scoped.comparisons);
  if (comparison?.tokenResult === "cache-shift") {
    return "cache-shift — sem redução comprovada";
  }
  if (comparison?.tokenReductionPercent !== undefined) {
    const percent = scoreboardPercent(comparison.tokenReductionPercent);
    if (comparison.tokenResult === "validated-reduction") {
      return `redução cache-aware validada — ${percent}`;
    }
    const evidence = qualityObservation(comparison) === "degraded"
      ? "qualidade observada degradada"
      : "preliminar";
    return `variação cache-aware medida — ${percent} (${evidence})`;
  }
  return SCOREBOARD_MISSING;
}

function scoreboardBlock(provider: Provider | undefined, report: Report): string {
  const title = provider ? `TokenPilot · ${providerName(provider)}` : "TokenPilot";
  const score = provider ? providerScore(report, provider) : SCOREBOARD_MISSING;
  return [title, "", score, ""].join("\n");
}

function summaryProviders(report: Report): Provider[] {
  const seen = new Set<Provider>();
  for (const row of report.coverage) seen.add(row.provider);
  return (["claude", "codex", "grok", "kimi"] as const).filter((provider) => seen.has(provider));
}

/**
 * Skill-facing scoreboard: the latest locally recorded, comparable,
 * cache-aware variation and its evidence state. Providers stay separate.
 * Rolling-window totals, USD, latency, and policy jargon stay out.
 */
export function reportSummaryMarkdown(report: Report): string {
  const providers = summaryProviders(report);
  if (providers.length === 0) return scoreboardBlock(undefined, report);
  return providers.map((provider) => scoreboardBlock(provider, report)).join("\n");
}

/** Detailed audit view. All session identifiers are opaque local UUIDs. */
export function reportMarkdown(report: Report): string {
  const lines = ["# TokenPilot — detailed telemetry report", "", `Generated: ${report.generatedAt}`, `Window: starts ${report.since}`, "", "## Measurement coverage", "", "| Provider | Sessions | Measured | Unavailable |", "| --- | ---: | ---: | ---: |"];
  for (const row of report.coverage) lines.push(`| ${row.provider} | ${integer(row.sessions)} | ${integer(row.measuredSessions)} | ${integer(row.unavailableSessions)} |`);
  if (report.coverage.length === 0) lines.push("| — | 0 | 0 | 0 |");
  lines.push("", "## Matched audit comparisons", "", "| Provider | Task / policy | Total basis | State | New / cached / created / pressure / total | Evidence | Latency |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const comparison of report.comparisons) {
    const evidence = `baseline: ${comparison.baselineSessionIds.join(", ")}<br>treatment: ${comparison.treatmentSessionIds.join(", ")}`;
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} / ${comparison.optimizationProfile} | ${comparison.totalSource} | ${comparisonResult(comparison)} | ${categoryLine(comparison)} | ${evidence} | ${latency(comparison)} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | no comparable measured pair | — | — | — |");
  lines.push("", "## Auditable sessions", "", "Only opaque IDs and classified metadata are present. Provider content, arguments, paths, and credentials are never included.", "", "| Run ID | Provider | Started | Mode / policy | Task / outcome | Measurement | Basis / total | Price snapshot | Reason |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const session of report.sessions ?? []) {
    lines.push(`| ${session.id} | ${session.provider} | ${session.startedAt} | ${session.mode} / ${session.policy} | ${session.taskKind} / ${session.outcome} | ${session.measurement} | ${session.measurementBasis} / ${session.totalSource} | ${session.pricingSnapshot ?? "none"} | ${session.unavailableReason ?? "—"} |`);
  }
  if ((report.sessions ?? []).length === 0) lines.push("| — | — | — | — | — | — | — | — | — |");
  lines.push("", "## API-equivalent USD", "", "API-equivalent USD is local modelling from the stored price snapshot, not a provider bill. Cache reads use the cached-input rate. Cache-shifts never publish avoided USD.", "", "| Provider | Task | Price profile | Expected / used / avoided | State |", "| --- | --- | --- | --- | --- |");
  for (const comparison of report.comparisons) {
    const profile = comparison.pricingProfile ? `${comparison.pricingProfile.label} (${comparison.pricingProfile.id}@${comparison.pricingProfile.version})` : "not configured / incompatible categories";
    const values = comparison.tokenResult === "cache-shift" ? "—" : `${usd(comparison.baselineExpectedUsd)} / ${usd(comparison.treatmentRecordedUsd)} / ${usd(comparison.estimatedUsdAvoided)}`;
    lines.push(`| ${comparison.provider} | ${comparison.taskKind} | ${profile} | ${values} | ${comparisonResult(comparison)} |`);
  }
  if (report.comparisons.length === 0) lines.push("| — | — | — | — | — |");
  lines.push("", "## Aggregate session counters", "", "These counters are shown separately and are never summed across providers.", "", "| Provider | Mode | Policy | Task | Sessions | New | Cached | Created | Output | Reasoning | Provider total | Retries |", "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.rows) {
    const policy = row.optimizationApplied ? row.optimizationProfile ?? "validated policy" : "none";
    lines.push(`| ${row.provider} | ${row.mode} | ${policy} | ${row.taskKind} | ${integer(row.sessions)} | ${integer(row.inputNew)} | ${integer(row.inputCached)} | ${integer(row.cacheCreated)} | ${integer(row.output)} | ${integer(row.reasoning)} | ${integer(row.reportedTotal)} | ${integer(row.retries)} |`);
  }
  if (report.rows.length === 0) lines.push("| — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |");
  lines.push("");
  return lines.join("\n");
}

export function reportDiagnosticsMarkdown(report: Report): string {
  const lines = ["# TokenPilot — diagnostics", "", "| Provider | Measured / unavailable | Limitation |", "| --- | --- | --- |"];
  for (const row of report.coverage) {
    let limitation = "compare only matching task, policy, total basis, and price snapshot";
    if (row.provider === "grok") limitation = "Grok Build 1.0.3+ TTY/TUI uses documented External OTEL v1; sessions without correlated counters remain unavailable; JSON single-turn is a fallback";
    if (row.provider === "kimi") limitation = "Kimi launches through its original CLI and remains envelope-only until a safe correlated measurement channel is available";
    lines.push(`| ${row.provider} | ${row.measuredSessions} / ${row.unavailableSessions} | ${limitation} |`);
  }
  if (report.coverage.length === 0) lines.push("| — | 0 / 0 | no sessions in this window |");
  lines.push("", "## Cohort and metric diagnostics", "");
  for (const comparison of report.comparisons) {
    const metric = comparison.totalSource === "category total"
      ? comparison.tokenResult === "incomparable"
        ? "provider total missing or unverified; category total available, but cohort matching failed"
        : "provider total missing or unverified; category total used"
      : comparison.totalSource === "provider-reported total"
        ? comparison.tokenResult === "incomparable"
          ? "verified cache-inclusive provider total available, but cohort matching failed"
          : "verified cache-inclusive provider total used"
        : comparison.reason?.includes("mixed metric bases")
          ? "provider-reported and category totals are both available but cannot be mixed"
          : "provider total missing or unverified; category total unavailable";
    lines.push(`- ${comparison.provider}/${comparison.taskKind}/${comparison.optimizationProfile}: ${comparison.tokenResult}; quality ${qualityObservation(comparison)}; ${comparison.reason ?? "matched cohorts"}; ${metric}.`);
  }
  if (report.comparisons.length === 0) lines.push("- No treatment cohort is available.");
  lines.push("", "## Per-session unavailable reasons", "");
  const unavailable = (report.sessions ?? []).filter((session) => session.measurement === "unavailable");
  for (const session of unavailable) {
    lines.push(`- ${session.id} (${session.provider}): ${session.unavailableReason ?? "no-correlated-counters"}.`);
  }
  if (unavailable.length === 0) lines.push("- None.");
  lines.push("");
  return lines.join("\n");
}

export function renderReportMarkdown(report: Report, view: ReportView): string {
  if (view === "summary") return reportSummaryMarkdown(report);
  if (view === "diagnostics") return reportDiagnosticsMarkdown(report);
  return reportMarkdown(report);
}
