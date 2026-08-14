export const PROVIDERS = ["claude", "codex", "grok", "kimi"] as const;

export type Provider = (typeof PROVIDERS)[number];
export type RunMode = "observe" | "balanced" | "deep" | "off";
export type TaskKind = "feature" | "bugfix" | "research" | "operations" | "other" | "unknown";
export type TaskOutcome = "completed" | "rework" | "abandoned" | "unknown";
export type CollectionState = "pending" | "collected" | "unavailable";

export interface TokenPilotConfig {
  version: 1;
  defaultMode: RunMode;
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
  tokenPressureDeltaPercent: number;
  baselineIqrTokenPressure: number;
  treatmentIqrTokenPressure: number;
  baselineMedianDurationSeconds: number;
  treatmentMedianDurationSeconds: number;
  baselineCompletionRate?: number;
  treatmentCompletionRate?: number;
  readiness: "ready" | "preliminary";
}
