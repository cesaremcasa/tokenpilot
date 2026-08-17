import { DatabaseSync } from "node:sqlite";
import { COLLECTION_UNAVAILABLE_REASONS, type AggregateRow, type AuditableSession, type CollectionUnavailableReason, type MeasurementCoverage, type PricingProfile, type Provider, type RunMode, type RunRecord, type SessionEvent, type SessionSummary, type TaskKind, type TaskOutcome, type UsageRecord } from "./types.js";
import { safeEvent, safeRun, safeUsage } from "./privacy.js";
import { assertSafeStateFile, ensurePrivateDirectory, hasSafePrivateDirectory, type TokenPilotPaths } from "./paths.js";
import { isPricingProfile } from "./pricing.js";

export interface TelemetryDatabaseOptions {
  /** A report must never create, migrate, or journal a database. */
  readOnly?: boolean;
}

export class TelemetryDatabase {
  private readonly db: DatabaseSync;
  private readonly hasReportedTotalColumn: boolean;
  private readonly hasReportedTotalSemanticsColumn: boolean;
  private readonly hasComparisonProfileColumn: boolean;
  private readonly hasPricingProfileColumn: boolean;
  private readonly hasCollectionReasonColumn: boolean;

  constructor(paths: TokenPilotPaths, options: TelemetryDatabaseOptions = {}) {
    if (options.readOnly) {
      if (!hasSafePrivateDirectory(paths, paths.dataDir)) throw new Error("TokenPilot telemetry directory is unavailable");
      assertSafeStateFile(paths, paths.databaseFile);
      this.db = new DatabaseSync(paths.databaseFile, { readOnly: true });
      this.hasReportedTotalColumn = this.usageColumnExists("reported_total");
      this.hasReportedTotalSemanticsColumn = this.usageColumnExists("reported_total_includes_cached_input");
      this.hasComparisonProfileColumn = this.runColumnExists("comparison_profile");
      this.hasPricingProfileColumn = this.runColumnExists("pricing_profile");
      this.hasCollectionReasonColumn = this.runColumnExists("collection_reason");
      return;
    }
    ensurePrivateDirectory(paths, paths.dataDir);
    assertSafeStateFile(paths, paths.databaseFile);
    this.db = new DatabaseSync(paths.databaseFile);
    // Keep the report command genuinely read-only. SQLite WAL readers create
    // sidecar files even in read-only mode, while the default rollback journal
    // leaves no state behind after a completed local write transaction.
    this.db.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.hasReportedTotalColumn = this.usageColumnExists("reported_total");
    this.hasReportedTotalSemanticsColumn = this.usageColumnExists("reported_total_includes_cached_input");
    this.hasComparisonProfileColumn = this.runColumnExists("comparison_profile");
    this.hasPricingProfileColumn = this.runColumnExists("pricing_profile");
    this.hasCollectionReasonColumn = this.runColumnExists("collection_reason");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER,
        cli_version TEXT,
        optimization_applied INTEGER NOT NULL DEFAULT 0,
        optimization_profile TEXT,
        comparison_profile TEXT,
        pricing_profile TEXT,
        collection_state TEXT NOT NULL,
        collection_reason TEXT,
        task_kind TEXT NOT NULL DEFAULT 'unknown',
        outcome TEXT NOT NULL DEFAULT 'unknown'
      ) STRICT;
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        input_new INTEGER,
        input_cached INTEGER,
        cache_created INTEGER,
        output INTEGER,
        reasoning INTEGER,
        model_calls INTEGER,
        reported_total INTEGER,
        reported_total_includes_cached_input INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        count INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS experiment_allocators (
        provider TEXT PRIMARY KEY,
        next_mode TEXT NOT NULL CHECK(next_mode IN ('observe', 'balanced'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_usage_run_id ON usage_records(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON session_events(run_id);
    `);
    this.ensureRunColumn("optimization_applied", "INTEGER NOT NULL DEFAULT 0");
    this.ensureRunColumn("optimization_profile", "TEXT");
    this.ensureRunColumn("comparison_profile", "TEXT");
    this.ensureRunColumn("pricing_profile", "TEXT");
    this.ensureRunColumn("collection_reason", "TEXT");
    this.ensureUsageColumn("reported_total", "INTEGER");
    this.ensureUsageColumn("reported_total_includes_cached_input", "INTEGER");
  }

  private usageColumnExists(name: string): boolean {
    const columns = this.db.prepare("PRAGMA table_info(usage_records)").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === name);
  }

  private ensureUsageColumn(name: "reported_total" | "reported_total_includes_cached_input", definition: string): void {
    if (!this.usageColumnExists(name)) this.db.exec(`ALTER TABLE usage_records ADD COLUMN ${name} ${definition}`);
  }

  private runColumnExists(name: string): boolean {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === name);
  }

  private ensureRunColumn(name: "optimization_applied" | "optimization_profile" | "comparison_profile" | "pricing_profile" | "collection_reason", definition: string): void {
    if (!this.runColumnExists(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
  }

  /**
   * Assign a new balanced-experiment session in a durable, provider-local
   * sequence. The first assignment is random; every later assignment for that
   * provider alternates, so concurrent terminals cannot silently bias the
   * 50/50 split. Task type is deliberately not used here because it is an
   * optional post-session classification and is never available at launch.
   */
  allocateBalancedMode(provider: Provider, random = Math.random): Extract<RunMode, "observe" | "balanced"> {
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const row = this.db.prepare("SELECT next_mode AS nextMode FROM experiment_allocators WHERE provider = ?")
        .get(provider) as { nextMode?: "observe" | "balanced" } | undefined;
      const mode = row?.nextMode ?? (random() < 0.5 ? "balanced" : "observe");
      const nextMode = mode === "balanced" ? "observe" : "balanced";
      this.db.prepare(`INSERT INTO experiment_allocators (provider, next_mode) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET next_mode = excluded.next_mode`).run(provider, nextMode);
      this.db.exec("COMMIT");
      return mode;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original allocation failure for fail-open launcher handling.
        }
      }
      throw error;
    }
  }

  createRun(record: RunRecord): void {
    safeRun(record);
    this.db.prepare(`INSERT INTO runs
      (id, provider, mode, started_at, ended_at, exit_code, cli_version, optimization_applied, optimization_profile, comparison_profile, pricing_profile, collection_state, collection_reason, task_kind, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.provider, record.mode, record.startedAt, record.endedAt ?? null, record.exitCode ?? null,
        record.cliVersion ?? null, record.optimizationApplied ? 1 : 0, record.optimizationProfile ?? null,
        record.comparisonProfile ?? null, record.pricingProfile ? JSON.stringify(record.pricingProfile) : null,
        record.collectionState, record.collectionReason ?? null, record.taskKind, record.outcome);
  }

  finishRun(id: string, exitCode: number | null, endedAt: string): void {
    this.db.prepare("UPDATE runs SET ended_at = ?, exit_code = ?, collection_state = 'pending', collection_reason = NULL WHERE id = ?")
      .run(endedAt, exitCode, id);
  }

  markCollection(id: string, state: "collected" | "unavailable", reason?: CollectionUnavailableReason): void {
    if (state === "collected" && reason) throw new Error("A measured collection cannot have an unavailable reason");
    this.db.prepare("UPDATE runs SET collection_state = ?, collection_reason = ? WHERE id = ?").run(state, reason ?? null, id);
  }

  addUsage(record: UsageRecord): void {
    safeUsage(record);
    this.db.prepare(`INSERT INTO usage_records
      (run_id, observed_at, source, input_new, input_cached, cache_created, output, reasoning, model_calls, reported_total, reported_total_includes_cached_input)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.runId, record.observedAt, record.source, record.inputNew ?? null, record.inputCached ?? null,
        record.cacheCreated ?? null, record.output ?? null, record.reasoning ?? null, record.modelCalls ?? null,
        record.reportedTotal ?? null, record.reportedTotalIncludesCachedInput === true ? 1 : null);
  }

  addEvent(record: SessionEvent): void {
    safeEvent(record);
    this.db.prepare("INSERT INTO session_events (run_id, observed_at, source, type, count) VALUES (?, ?, ?, ?, ?)")
      .run(record.runId, record.observedAt, record.source, record.type, record.count);
  }

  private storedPricingProfile(value: unknown): PricingProfile | undefined {
    if (typeof value !== "string" || value.length > 2_048) return undefined;
    try {
      const profile = JSON.parse(value) as unknown;
      return isPricingProfile(profile) ? profile : undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeRun(row: RunRecord & { optimizationApplied?: boolean | number; pricingProfile?: string | PricingProfile | null; collectionReason?: string | null }): RunRecord {
    const pricingProfile = typeof row.pricingProfile === "string" ? this.storedPricingProfile(row.pricingProfile) : row.pricingProfile;
    const collectionReason = COLLECTION_UNAVAILABLE_REASONS.includes(row.collectionReason as CollectionUnavailableReason) ? row.collectionReason as CollectionUnavailableReason : undefined;
    return { ...row, pricingProfile, collectionReason, optimizationApplied: Boolean(row.optimizationApplied) };
  }

  getPendingRuns(): RunRecord[] {
    return (this.db.prepare(`SELECT id, provider, mode, started_at AS startedAt, ended_at AS endedAt,
        exit_code AS exitCode, cli_version AS cliVersion, optimization_applied AS optimizationApplied,
        optimization_profile AS optimizationProfile, ${this.hasComparisonProfileColumn ? "comparison_profile" : "NULL"} AS comparisonProfile, collection_state AS collectionState,
        ${this.hasCollectionReasonColumn ? "collection_reason" : "NULL"} AS collectionReason,
        ${this.hasPricingProfileColumn ? "pricing_profile" : "NULL"} AS pricingProfile,
        task_kind AS taskKind, outcome FROM runs
        WHERE collection_state = 'pending' AND ended_at IS NOT NULL ORDER BY ended_at ASC`)
      .all() as unknown as Array<RunRecord & { optimizationApplied?: number }>).map((row) => this.normalizeRun(row));
  }

  /**
   * Content-free session index for optional post-session classification. It
   * intentionally exposes only the random run id and fields already in the
   * database contract; prompts, paths, and provider output are unavailable.
   */
  recentRunsSince(since: string, unclassified = false, limit = 50): RunRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid TokenPilot session limit");
    const filter = unclassified ? "AND task_kind = 'unknown'" : "";
    return (this.db.prepare(`SELECT id, provider, mode, started_at AS startedAt, ended_at AS endedAt,
        exit_code AS exitCode, cli_version AS cliVersion, optimization_applied AS optimizationApplied,
        optimization_profile AS optimizationProfile, ${this.hasComparisonProfileColumn ? "comparison_profile" : "NULL"} AS comparisonProfile,
        ${this.hasPricingProfileColumn ? "pricing_profile" : "NULL"} AS pricingProfile,
        collection_state AS collectionState, ${this.hasCollectionReasonColumn ? "collection_reason" : "NULL"} AS collectionReason, task_kind AS taskKind, outcome
        FROM runs WHERE started_at >= ? ${filter} ORDER BY started_at DESC LIMIT ?`)
      .all(since, limit) as unknown as Array<RunRecord & { optimizationApplied?: number }>).map((row) => this.normalizeRun(row));
  }

  hasUsage(runId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM usage_records WHERE run_id = ? LIMIT 1").get(runId) as { present?: number } | undefined;
    return row?.present === 1;
  }

  classify(id: string, kind: TaskKind, outcome: TaskOutcome): boolean {
    const result = this.db.prepare("UPDATE runs SET task_kind = ?, outcome = ? WHERE id = ?").run(kind, outcome, id);
    return result.changes === 1;
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare(`SELECT id, provider, mode, started_at AS startedAt, ended_at AS endedAt,
      exit_code AS exitCode, cli_version AS cliVersion, optimization_applied AS optimizationApplied,
      optimization_profile AS optimizationProfile, ${this.hasComparisonProfileColumn ? "comparison_profile" : "NULL"} AS comparisonProfile,
      ${this.hasPricingProfileColumn ? "pricing_profile" : "NULL"} AS pricingProfile, collection_state AS collectionState,
      ${this.hasCollectionReasonColumn ? "collection_reason" : "NULL"} AS collectionReason,
      task_kind AS taskKind, outcome FROM runs WHERE id = ?`).get(id) as RunRecord & { optimizationApplied?: number } | undefined;
    return row ? this.normalizeRun(row) : undefined;
  }

  aggregateSince(since: string): AggregateRow[] {
    const reportedTotal = this.hasReportedTotalColumn ? "SUM(COALESCE(u.reported_total, 0))" : "0";
    return this.db.prepare(`
      WITH usage AS (
        SELECT run_id, SUM(COALESCE(input_new, 0)) AS input_new, SUM(COALESCE(input_cached, 0)) AS input_cached,
          SUM(COALESCE(cache_created, 0)) AS cache_created, SUM(COALESCE(output, 0)) AS output,
          SUM(COALESCE(reasoning, 0)) AS reasoning, SUM(COALESCE(model_calls, 0)) AS model_calls${this.hasReportedTotalColumn ? ", SUM(COALESCE(reported_total, 0)) AS reported_total" : ""}
        FROM usage_records GROUP BY run_id
      ), events AS (
        SELECT run_id,
          SUM(CASE WHEN type = 'compaction' THEN count ELSE 0 END) AS compactions,
          SUM(CASE WHEN type = 'retry' THEN count ELSE 0 END) AS retries
        FROM session_events GROUP BY run_id
      )
      SELECT r.provider, r.mode, r.optimization_applied AS optimizationApplied,
        r.optimization_profile AS optimizationProfile, r.task_kind AS taskKind, COUNT(*) AS sessions,
        SUM(CASE WHEN r.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN r.outcome = 'rework' THEN 1 ELSE 0 END) AS rework,
        SUM(CASE WHEN r.outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
        SUM(CASE WHEN r.ended_at IS NULL THEN 0 ELSE MAX(0, strftime('%s', r.ended_at) - strftime('%s', r.started_at)) END) AS durationSeconds,
        SUM(COALESCE(u.input_new, 0)) AS inputNew, SUM(COALESCE(u.input_cached, 0)) AS inputCached,
        SUM(COALESCE(u.cache_created, 0)) AS cacheCreated, SUM(COALESCE(u.output, 0)) AS output,
        SUM(COALESCE(u.reasoning, 0)) AS reasoning, SUM(COALESCE(u.model_calls, 0)) AS modelCalls,
        ${reportedTotal} AS reportedTotal,
        SUM(COALESCE(e.compactions, 0)) AS compactions, SUM(COALESCE(e.retries, 0)) AS retries
      FROM runs r LEFT JOIN usage u ON u.run_id = r.id LEFT JOIN events e ON e.run_id = r.id
      WHERE r.started_at >= ? GROUP BY r.provider, r.mode, r.optimization_applied, r.optimization_profile, r.task_kind
      ORDER BY r.provider, r.mode, r.optimization_profile, r.task_kind
    `).all(since).map((row) => ({
      ...(row as unknown as AggregateRow),
      optimizationApplied: Boolean((row as { optimizationApplied: number }).optimizationApplied)
    }));
  }

  measurementCoverageSince(since: string): MeasurementCoverage[] {
    return this.db.prepare(`
      WITH measured AS (SELECT DISTINCT run_id FROM usage_records)
      SELECT r.provider AS provider, COUNT(*) AS sessions,
        SUM(CASE WHEN m.run_id IS NOT NULL THEN 1 ELSE 0 END) AS measuredSessions,
        SUM(CASE WHEN m.run_id IS NULL THEN 1 ELSE 0 END) AS unavailableSessions
      FROM runs r LEFT JOIN measured m ON m.run_id = r.id
      WHERE r.started_at >= ?
      GROUP BY r.provider
      ORDER BY r.provider
    `).all(since) as unknown as MeasurementCoverage[];
  }

  /** Safe, content-free evidence index. A pending run is explicitly unavailable. */
  auditableSessionsSince(since: string, unclassified = false, limit = 100): AuditableSession[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid TokenPilot session limit");
    const filter = unclassified ? "AND r.task_kind = 'unknown'" : "";
    const reportedSemantics = this.hasReportedTotalSemanticsColumn
      ? "MAX(CASE WHEN u.reported_total IS NOT NULL AND (u.reported_total_includes_cached_input = 1 OR u.source = 'grok-cli-json-usage-v1') THEN 1 ELSE 0 END)"
      : "0";
    const rows = this.db.prepare(`
      WITH usage AS (
        SELECT u.run_id, COUNT(*) AS samples,
          MAX(CASE WHEN u.input_new IS NOT NULL THEN 1 ELSE 0 END) AS has_input_new,
          MAX(CASE WHEN u.input_cached IS NOT NULL THEN 1 ELSE 0 END) AS has_input_cached,
          MAX(CASE WHEN u.cache_created IS NOT NULL THEN 1 ELSE 0 END) AS has_cache_created,
          MAX(CASE WHEN u.output IS NOT NULL THEN 1 ELSE 0 END) AS has_output,
          ${this.hasReportedTotalColumn ? "MAX(CASE WHEN u.reported_total IS NOT NULL THEN 1 ELSE 0 END)" : "0"} AS has_reported_total,
          ${reportedSemantics} AS reported_total_includes_cached_input
        FROM usage_records u GROUP BY u.run_id
      )
      SELECT r.id, r.provider, r.started_at AS startedAt, r.mode,
        COALESCE(r.optimization_profile, ${this.hasComparisonProfileColumn ? "r.comparison_profile" : "NULL"}, 'none') AS policy,
        r.task_kind AS taskKind, r.outcome, r.collection_state AS collectionState,
        ${this.hasCollectionReasonColumn ? "r.collection_reason" : "NULL"} AS collectionReason,
        ${this.hasPricingProfileColumn ? "r.pricing_profile" : "NULL"} AS pricingProfile,
        COALESCE(u.samples, 0) AS samples, COALESCE(u.has_reported_total, 0) AS hasReportedTotal,
        COALESCE(u.reported_total_includes_cached_input, 0) AS reportedTotalIncludesCachedInput,
        COALESCE(u.has_input_new, 0) AS hasInputNew, COALESCE(u.has_input_cached, 0) AS hasInputCached,
        COALESCE(u.has_cache_created, 0) AS hasCacheCreated, COALESCE(u.has_output, 0) AS hasOutput
      FROM runs r LEFT JOIN usage u ON u.run_id = r.id
      WHERE r.started_at >= ? ${filter} ORDER BY r.started_at DESC LIMIT ?
    `).all(since, limit) as unknown as Array<{
      id: string; provider: Provider; startedAt: string; mode: RunMode; policy: string; taskKind: TaskKind; outcome: TaskOutcome;
      collectionState: string; collectionReason?: string | null; pricingProfile?: string | null; samples: number; hasReportedTotal: number;
      reportedTotalIncludesCachedInput: number; hasInputNew: number; hasInputCached: number; hasCacheCreated: number; hasOutput: number;
    }>;
    return rows.map((row) => {
      const measured = row.samples > 0;
      const categoryComplete = row.hasInputNew === 1 && row.hasInputCached === 1 && row.hasCacheCreated === 1 && row.hasOutput === 1;
      const categoryPresent = row.hasInputNew === 1 || row.hasInputCached === 1 || row.hasCacheCreated === 1 || row.hasOutput === 1;
      const providerTotal = row.hasReportedTotal === 1 && row.reportedTotalIncludesCachedInput === 1;
      const storedReason = COLLECTION_UNAVAILABLE_REASONS.includes(row.collectionReason as CollectionUnavailableReason) ? row.collectionReason as CollectionUnavailableReason : undefined;
      const unavailableReason = measured ? undefined : row.collectionState === "pending" ? "collection-pending" : storedReason ?? "no-correlated-counters";
      const profile = this.storedPricingProfile(row.pricingProfile);
      return {
        id: row.id,
        provider: row.provider,
        startedAt: row.startedAt,
        mode: row.mode,
        policy: row.policy,
        taskKind: row.taskKind,
        outcome: row.outcome,
        measurement: measured ? "measured" : "unavailable",
        measurementBasis: providerTotal ? "provider-reported" : categoryPresent ? "category-counters" : row.hasReportedTotal === 1 ? "provider-reported" : "none",
        totalSource: providerTotal ? "provider-reported total" : categoryComplete ? "category total" : "none",
        pricingSnapshot: profile ? `${profile.id}@${profile.version}` : undefined,
        unavailableReason
      };
    });
  }

  sessionSummariesSince(since: string): SessionSummary[] {
    const reportedTotal = this.hasReportedTotalColumn ? "u.reported_total" : "NULL";
    const reportedTotalSemantics = this.hasReportedTotalSemanticsColumn ? "u.reported_total_includes_cached_input" : "0";
    return (this.db.prepare(`
      WITH usage AS (
        SELECT run_id, SUM(COALESCE(input_new, 0)) AS input_new, SUM(COALESCE(input_cached, 0)) AS input_cached,
          SUM(COALESCE(cache_created, 0)) AS cache_created, SUM(COALESCE(output, 0)) AS output,
          SUM(COALESCE(reasoning, 0)) AS reasoning,
          MAX(CASE WHEN input_new IS NOT NULL OR input_cached IS NOT NULL OR cache_created IS NOT NULL OR output IS NOT NULL OR reasoning IS NOT NULL THEN 1 ELSE 0 END) AS has_detailed_usage,
          MAX(CASE WHEN input_new IS NOT NULL THEN 1 ELSE 0 END) AS has_input_new,
          MAX(CASE WHEN input_cached IS NOT NULL THEN 1 ELSE 0 END) AS has_input_cached,
          MAX(CASE WHEN cache_created IS NOT NULL THEN 1 ELSE 0 END) AS has_cache_created,
          MAX(CASE WHEN output IS NOT NULL THEN 1 ELSE 0 END) AS has_output,
          MAX(CASE WHEN reasoning IS NOT NULL THEN 1 ELSE 0 END) AS has_reasoning${this.hasReportedTotalColumn ? ", SUM(CASE WHEN reported_total IS NOT NULL THEN reported_total ELSE 0 END) AS reported_total, MAX(CASE WHEN reported_total IS NOT NULL THEN 1 ELSE 0 END) AS has_reported_total" : ""}${this.hasReportedTotalSemanticsColumn ? ", MAX(CASE WHEN reported_total IS NOT NULL AND (reported_total_includes_cached_input = 1 OR source = 'grok-cli-json-usage-v1') THEN 1 ELSE 0 END) AS reported_total_includes_cached_input" : ""}
        FROM usage_records GROUP BY run_id
      ), events AS (
        SELECT run_id,
          SUM(CASE WHEN type = 'compaction' THEN count ELSE 0 END) AS compactions,
          SUM(CASE WHEN type = 'retry' THEN count ELSE 0 END) AS retries
        FROM session_events GROUP BY run_id
      )
      SELECT r.id, r.provider, r.mode, r.optimization_applied AS optimizationApplied,
        r.optimization_profile AS optimizationProfile, ${this.hasComparisonProfileColumn ? "r.comparison_profile" : "NULL"} AS comparisonProfile,
        ${this.hasPricingProfileColumn ? "r.pricing_profile" : "NULL"} AS pricingProfile, r.task_kind AS taskKind, r.outcome,
        MAX(0, strftime('%s', COALESCE(r.ended_at, datetime('now'))) - strftime('%s', r.started_at)) AS durationSeconds,
        u.input_new AS inputNew, u.input_cached AS inputCached, u.cache_created AS cacheCreated,
        u.output AS output, u.reasoning AS reasoning,
        ${reportedTotal} AS reportedTotal, COALESCE(u.has_reported_total, 0) AS hasReportedTotal, COALESCE(${reportedTotalSemantics}, 0) AS reportedTotalIncludesCachedInput, COALESCE(u.has_detailed_usage, 0) AS hasDetailedUsage,
        COALESCE(u.has_input_new, 0) AS hasInputNew, COALESCE(u.has_input_cached, 0) AS hasInputCached,
        COALESCE(u.has_cache_created, 0) AS hasCacheCreated, COALESCE(u.has_output, 0) AS hasOutput,
        COALESCE(u.has_reasoning, 0) AS hasReasoning,
        COALESCE(e.compactions, 0) AS compactions, COALESCE(e.retries, 0) AS retries
      FROM runs r JOIN usage u ON u.run_id = r.id LEFT JOIN events e ON e.run_id = r.id
      WHERE r.started_at >= ?
      ORDER BY r.provider, r.task_kind, r.started_at
    `).all(since) as unknown as Array<Omit<SessionSummary, "optimizationApplied" | "measurementBasis" | "pricingProfile" | "pricingCompatible" | "reportedTotalIncludesCachedInput" | "categoryMetricsComplete"> & {
      optimizationApplied: number;
      pricingProfile?: string | null;
      hasDetailedUsage: number;
      hasInputNew: number;
      hasInputCached: number;
      hasCacheCreated: number;
      hasOutput: number;
      hasReasoning: number;
      hasReportedTotal: number;
      reportedTotalIncludesCachedInput: number;
    }>).map((row) => {
      const pricingProfile = this.storedPricingProfile(row.pricingProfile);
      const categoriesPresent = row.hasInputNew === 1 && row.hasInputCached === 1 && row.hasCacheCreated === 1 && row.hasOutput === 1;
      const reasoningPresent = pricingProfile?.rates.reasoningUsdPerMillion === undefined || row.hasReasoning === 1;
      return {
        ...row,
        pricingProfile,
        pricingCompatible: Boolean(pricingProfile && categoriesPresent && reasoningPresent),
        reportedTotal: row.hasReportedTotal === 1 ? row.reportedTotal : undefined,
        reportedTotalIncludesCachedInput: row.hasReportedTotal === 1 && row.reportedTotalIncludesCachedInput === 1,
        categoryMetricsComplete: categoriesPresent,
        measurementBasis: row.hasDetailedUsage === 1 ? "token-pressure" : "provider-total",
        optimizationApplied: Boolean(row.optimizationApplied)
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
