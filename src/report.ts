import fs from "node:fs";
import type { AggregateRow, AuditableSession, MeasurementCoverage, Provider, SessionSummary, TreatmentComparison } from "./types.js";
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

function emptyReport(since: string): Report {
  return { generatedAt: new Date().toISOString(), since, rows: [], coverage: [], comparisons: [], sessions: [] };
}

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

/** Read-only report construction. It never creates, migrates, or journals telemetry. */
export function buildReport(paths: TokenPilotPaths, days: number): Report {
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("--days must be between 1 and 365");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
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

function completionRate(sessions: SessionSummary[]): number | undefined {
  const classified = sessions.filter((session) => session.outcome !== "unknown");
  return classified.length === 0 ? undefined : classified.filter((session) => session.outcome === "completed").length / classified.length;
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
 * complete category total is used, which keeps Claude eligible for 5+5.
 */
export function treatmentComparisons(summaries: SessionSummary[]): TreatmentComparison[] {
  const treatments = new Map<string, SessionSummary[]>();
  for (const session of summaries) {
    const profile = session.comparisonProfile ?? (session.mode === "balanced" ? session.optimizationProfile : undefined);
    if (!profile) continue;
    if (session.mode === "balanced" && session.optimizationApplied && session.optimizationProfile) {
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
    const classifiedWork = taskKind !== "unknown" && taskKind !== "benchmark";
    const readiness = classifiedWork && baseline.length >= 5 && treatment.length >= 5 ? "ready" as const : "preliminary" as const;
    const tokenResult: TreatmentComparison["tokenResult"] = isCacheShift
      ? "cache-shift"
      : readiness === "ready" && estimatedTokensAvoided > 0 && tokenReductionPercent > 0 ? "validated-reduction" : "preliminary-signal";
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
    return [{
      provider,
      taskKind,
      optimizationProfile,
      metricLabel: totalSource,
      totalSource,
      baselineSessions: baseline.length,
      treatmentSessions: treatment.length,
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
      baselineCompletionRate: completionRate(baseline),
      treatmentCompletionRate: completionRate(treatment),
      pricingProfile: attachedProfile ? { id: attachedProfile.id, version: attachedProfile.version, label: attachedProfile.label, currency: attachedProfile.currency } : undefined,
      baselineExpectedUsd: isCacheShift ? undefined : baselineExpectedUsd,
      treatmentRecordedUsd: isCacheShift ? undefined : treatmentRecordedUsd,
      estimatedUsdAvoided: isCacheShift ? undefined : rawEstimatedUsdAvoided,
      usdReductionPercent: isCacheShift ? undefined : usdReductionPercent,
      readiness,
      tokenResult,
      reason: isCacheShift ? "new input moved into cache reads while the complete total stayed flat" : tokenResult === "validated-reduction" ? undefined : "sample is directional and does not satisfy validated-reduction criteria",
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
    readiness: "unavailable",
    tokenResult,
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

function comparisonResult(comparison: TreatmentComparison): string {
  if (comparison.tokenResult === "limited") return `limited measurement — ${comparison.reason ?? "numeric total unavailable"}`;
  if (comparison.tokenResult === "incomparable") return `no comparable base — ${comparison.reason ?? "cohorts do not match"}`;
  if (comparison.tokenResult === "cache-shift") return "cache-shift — no reduction emitted";
  if (comparison.tokenResult === "validated-reduction") return `${(comparison.tokenReductionPercent ?? 0).toFixed(1)}% validated reduction`;
  return `${(comparison.tokenReductionPercent ?? 0).toFixed(1)}% preliminary signal — not an economy`;
}

function categoryLine(comparison: TreatmentComparison): string {
  if (comparison.baselineMedianInputNew === undefined || comparison.treatmentMedianInputNew === undefined || comparison.baselineMedianComparableTotal === undefined || comparison.treatmentMedianComparableTotal === undefined) return "—";
  return `new ${integer(comparison.baselineMedianInputNew)}→${integer(comparison.treatmentMedianInputNew)}; cached ${integer(comparison.baselineMedianCachedInput!)}→${integer(comparison.treatmentMedianCachedInput!)}; created ${integer(comparison.baselineMedianCacheCreated!)}→${integer(comparison.treatmentMedianCacheCreated!)}; pressure ${integer(comparison.baselineMedianTokenPressure!)}→${integer(comparison.treatmentMedianTokenPressure!)}; total ${integer(comparison.baselineMedianComparableTotal)}→${integer(comparison.treatmentMedianComparableTotal)}`;
}

function summaryComparison(comparisons: TreatmentComparison[]): TreatmentComparison | undefined {
  const versioned = comparisons.filter((comparison) => comparison.optimizationProfile !== "none");
  if (versioned.length === 0) return comparisons[0];
  const latestProfile = versioned
    .map((comparison) => comparison.optimizationProfile)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1)!;
  const current = versioned.filter((comparison) => comparison.optimizationProfile === latestProfile);
  const taskRank = (comparison: TreatmentComparison) => comparison.taskKind === "unknown" ? 0 : comparison.taskKind === "benchmark" ? 1 : 2;
  const conservativeRank = (comparison: TreatmentComparison) => ({
    "validated-reduction": 0,
    "preliminary-signal": 1,
    incomparable: 2,
    limited: 3,
    "cache-shift": 4
  })[comparison.tokenResult];
  return [...current].sort((left, right) => taskRank(left) - taskRank(right) || conservativeRank(left) - conservativeRank(right)).at(-1);
}

function providerName(provider: Provider): string {
  return provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider === "grok" ? "Grok" : "Kimi";
}

const SCOREBOARD_MISSING = "sem medição ainda";
const SCOREBOARD_LABEL_WIDTH = 20;

function scoreboardInteger(value: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value);
}

function scoreboardPercent(value: number): string {
  const bounded = Math.max(0, value);
  const rounded = Math.round(bounded * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1).replace(".", ",")}`;
  return `${text}% a menos`;
}

function emptySummaryWindow(report: Report): Report {
  const providers = [...new Set(report.coverage.map((row) => row.provider))];
  return {
    generatedAt: report.generatedAt,
    since: report.since,
    rows: [],
    coverage: providers.map((provider) => ({ provider, sessions: 0, measuredSessions: 0, unavailableSessions: 0 })),
    comparisons: [],
    sessions: []
  };
}

function windowScore(report: Report, provider: Provider): { headline: string; detail?: string } {
  const scoped = filterReportByProvider(report, provider);
  const comparison = summaryComparison(scoped.comparisons);
  const expected = comparison?.baselineExpectedTreatmentTokens;
  const used = comparison?.treatmentRecordedTokens;
  const hasTotals = expected !== undefined && used !== undefined && expected > 0;
  if (!comparison || !hasTotals) return { headline: SCOREBOARD_MISSING };
  if (comparison.tokenResult === "validated-reduction") {
    return {
      headline: scoreboardPercent(((expected - used) / expected) * 100),
      detail: `${scoreboardInteger(expected)} → ${scoreboardInteger(used)} tokens`
    };
  }
  if (comparison.tokenResult === "cache-shift") {
    return {
      headline: scoreboardPercent(0),
      detail: `${scoreboardInteger(expected)} → ${scoreboardInteger(used)} tokens`
    };
  }
  return { headline: SCOREBOARD_MISSING };
}

function scoreboardBlock(provider: Provider | undefined, last24Hours: Report, last7Days: Report): string {
  const title = provider ? `TokenPilot · ${providerName(provider)}` : "TokenPilot";
  const hours = provider ? windowScore(last24Hours, provider) : { headline: SCOREBOARD_MISSING };
  const days = provider ? windowScore(last7Days, provider) : { headline: SCOREBOARD_MISSING };
  const lines = [title, "", `últimas 24 horas`.padEnd(SCOREBOARD_LABEL_WIDTH) + hours.headline];
  if (hours.detail) lines.push("".padEnd(SCOREBOARD_LABEL_WIDTH) + hours.detail);
  lines.push("", `7 dias`.padEnd(SCOREBOARD_LABEL_WIDTH) + days.headline);
  if (days.detail) lines.push("".padEnd(SCOREBOARD_LABEL_WIDTH) + days.detail);
  lines.push("");
  return lines.join("\n");
}

function summaryProviders(last24Hours: Report, last7Days: Report): Provider[] {
  const seen = new Set<Provider>();
  for (const row of [...last24Hours.coverage, ...last7Days.coverage]) seen.add(row.provider);
  return (["claude", "codex", "grok", "kimi"] as const).filter((provider) => seen.has(provider));
}

/**
 * Skill-facing scoreboard: rolling last 24 hours, then last 7 days.
 * Providers stay separate. USD, latency, and policy jargon stay out.
 */
export function reportSummaryMarkdown(last7Days: Report, last24Hours: Report = emptySummaryWindow(last7Days)): string {
  const providers = summaryProviders(last24Hours, last7Days);
  if (providers.length === 0) return scoreboardBlock(undefined, last24Hours, last7Days);
  return providers.map((provider) => scoreboardBlock(provider, last24Hours, last7Days)).join("\n");
}

/** Summary windows are always rolling from now: the last 24 hours, then 7 days. */
export function buildRollingSummaryReports(paths: TokenPilotPaths): { last24Hours: Report; last7Days: Report } {
  return {
    last24Hours: buildReport(paths, 1),
    last7Days: buildReport(paths, 7)
  };
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
    lines.push(`- ${comparison.provider}/${comparison.taskKind}/${comparison.optimizationProfile}: ${comparison.tokenResult}; ${comparison.reason ?? "matched cohorts"}; ${metric}.`);
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
