export const PROVIDERS = ["claude", "codex", "grok", "kimi"] as const;

export type Provider = (typeof PROVIDERS)[number];
export type RunMode = "observe" | "balanced" | "deep" | "off";
export type TaskKind = "feature" | "bugfix" | "research" | "operations" | "benchmark" | "other" | "unknown";
export type TaskOutcome = "completed" | "rework" | "abandoned" | "unknown";
export type CollectionState = "pending" | "collected" | "unavailable";

/** API-equivalent USD rates, expressed per one million units. */
export interface PricingRates {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheCreationUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Omit when the provider does not publish reasoning usage separately. */
  reasoningUsdPerMillion?: number;
}

/** A user-chosen, local-only API-equivalent pricing profile. */
export interface PricingProfile {
  id: string;
  provider: Provider;
  version: string;
  label: string;
  currency: "USD";
  rates: PricingRates;
}

export interface TokenPilotConfig {
  version: 2;
  defaultMode: RunMode;
  pricingProfiles: PricingProfile[];
  activePricing: Partial<Record<Provider, string>>;
}

export interface RunRecord {
  id: string;
  provider: Provider;
  mode: RunMode;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  cliVersion?: string;
  optimizationApplied?: boolean;
  optimizationProfile?: string;
  /** The policy profile assigned to this observe/treatment experiment pair. */
  comparisonProfile?: string;
  /** Local API-equivalent profile snapshot captured before the provider starts. */
  pricingProfile?: PricingProfile;
  collectionState: CollectionState;
  taskKind: TaskKind;
  outcome: TaskOutcome;
}

export interface UsageMetrics {
  inputNew?: number;
  inputCached?: number;
  cacheCreated?: number;
  output?: number;
  reasoning?: number;
  modelCalls?: number;
  /** A provider-published session total that has no safe category breakdown. */
  reportedTotal?: number;
}

export interface UsageRecord extends UsageMetrics {
  runId: string;
  observedAt: string;
  source: string;
}

export interface SessionEvent {
  runId: string;
  observedAt: string;
  type: "compaction" | "retry" | "model_switch";
  count: number;
  source: string;
}

export interface ProviderCapabilities {
  telemetry: "otlp-metrics" | "session-files" | "wire" | "cli-json" | "unknown";
  supportsBalancedOptimization: boolean;
  notes: string;
}

export interface ParsedTelemetry {
  usage?: UsageMetrics;
  events: Array<Pick<SessionEvent, "type" | "count">>;
}

export interface ProviderAdapter {
  provider: Provider;
  capabilities: ProviderCapabilities;
  parseTelemetryLine(line: string): ParsedTelemetry | undefined;
}

export interface AggregateRow {
  provider: Provider;
  mode: RunMode;
  optimizationApplied: boolean;
  optimizationProfile?: string;
  taskKind: TaskKind;
  sessions: number;
  completed: number;
  rework: number;
  abandoned: number;
  durationSeconds: number;
  inputNew: number;
  inputCached: number;
  cacheCreated: number;
  output: number;
  reasoning: number;
  modelCalls: number;
  reportedTotal: number;
  compactions: number;
  retries: number;
}

export interface MeasurementCoverage {
  provider: Provider;
  sessions: number;
  measuredSessions: number;
  unavailableSessions: number;
}

export interface SessionSummary {
  id: string;
  provider: Provider;
  mode: RunMode;
  optimizationApplied: boolean;
  optimizationProfile?: string;
  comparisonProfile?: string;
  taskKind: TaskKind;
  outcome: TaskOutcome;
  durationSeconds: number;
  inputNew: number;
  inputCached: number;
  cacheCreated: number;
  output: number;
  reasoning: number;
  reportedTotal?: number;
  measurementBasis?: "token-pressure" | "provider-total";
  /** All numeric categories needed by the attached pricing profile were published. */
  pricingCompatible?: boolean;
  pricingProfile?: PricingProfile;
  compactions: number;
  retries: number;
}

export interface TreatmentComparison {
  provider: Provider;
  taskKind: TaskKind;
  optimizationProfile: string;
  metricLabel: "token pressure" | "provider-reported total";
  baselineSessions: number;
  treatmentSessions: number;
  baselineMedianTokenPressure: number;
  treatmentMedianTokenPressure: number;
  /**
   * Counterfactual treatment total using the matched observe median. This is
   * deliberately a within-provider token estimate, never a money estimate.
   */
  baselineExpectedTreatmentTokens: number;
  /** Tokens actually reported by the matched treatment sessions. */
  treatmentRecordedTokens: number;
  /** Matched-baseline estimate minus measured treatment use; may be negative. */
  estimatedTokensAvoided: number;
  /** Positive means the treatment's median used fewer tokens. */
  tokenReductionPercent: number;
  tokenPressureDeltaPercent: number;
  baselineIqrTokenPressure: number;
  treatmentIqrTokenPressure: number;
  baselineMedianDurationSeconds: number;
  treatmentMedianDurationSeconds: number;
  /** Positive means the treatment took longer end-to-end in the local CLI. */
  latencyDeltaSeconds: number;
  latencyDeltaPercent: number;
  latencyResult: "faster" | "slower" | "unchanged";
  baselineCompletionRate?: number;
  treatmentCompletionRate?: number;
  pricingProfile?: Pick<PricingProfile, "id" | "version" | "label" | "currency">;
  baselineExpectedUsd?: number;
  treatmentRecordedUsd?: number;
  estimatedUsdAvoided?: number;
  usdReductionPercent?: number;
  readiness: "ready" | "preliminary";
  /** A token-only conclusion. Preliminary results are intentionally not claims. */
  tokenResult: "preliminary" | "measured-reduction" | "no-reduction";
}
