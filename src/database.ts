import { DatabaseSync } from "node:sqlite";
import type { AggregateRow, MeasurementCoverage, RunRecord, SessionEvent, SessionSummary, TaskKind, TaskOutcome, UsageRecord } from "./types.js";
import { safeEvent, safeRun, safeUsage } from "./privacy.js";
import { assertSafeStateFile, ensurePrivateDirectory, type TokenPilotPaths } from "./paths.js";

export class TelemetryDatabase {
  private readonly db: DatabaseSync;

  constructor(paths: TokenPilotPaths) {
    ensurePrivateDirectory(paths, paths.dataDir);
    assertSafeStateFile(paths, paths.databaseFile);
    this.db = new DatabaseSync(paths.databaseFile);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
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
        collection_state TEXT NOT NULL,
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
        model_calls INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        count INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_usage_run_id ON usage_records(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON session_events(run_id);
    `);
    this.ensureRunColumn("optimization_applied", "INTEGER NOT NULL DEFAULT 0");
    this.ensureRunColumn("optimization_profile", "TEXT");
  }

  private ensureRunColumn(name: "optimization_applied" | "optimization_profile", definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
    }
  }

  createRun(record: RunRecord): void {
    safeRun(record);
    this.db.prepare(`INSERT INTO runs
      (id, provider, mode, started_at, ended_at, exit_code, cli_version, optimization_applied, optimization_profile, collection_state, task_kind, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.provider, record.mode, record.startedAt, record.endedAt ?? null, record.exitCode ?? null,
        record.cliVersion ?? null, record.optimizationApplied ? 1 : 0, record.optimizationProfile ?? null,
        record.collectionState, record.taskKind, record.outcome);
  }

  finishRun(id: string, exitCode: number | null, endedAt: string): void {
    this.db.prepare("UPDATE runs SET ended_at = ?, exit_code = ?, collection_state = 'pending' WHERE id = ?")
      .run(endedAt, exitCode, id);
  }

  markCollection(id: string, state: "collected" | "unavailable"): void {
    this.db.prepare("UPDATE runs SET collection_state = ? WHERE id = ?").run(state, id);
  }

  addUsage(record: UsageRecord): void {
    safeUsage(record);
    this.db.prepare(`INSERT INTO usage_records
      (run_id, observed_at, source, input_new, input_cached, cache_created, output, reasoning, model_calls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.runId, record.observedAt, record.source, record.inputNew ?? null, record.inputCached ?? null,
        record.cacheCreated ?? null, record.output ?? null, record.reasoning ?? null, record.modelCalls ?? null);
  }

  addEvent(record: SessionEvent): void {
    safeEvent(record);
    this.db.prepare("INSERT INTO session_events (run_id, observed_at, source, type, count) VALUES (?, ?, ?, ?, ?)")
      .run(record.runId, record.observedAt, record.source, record.type, record.count);
  }

  private normalizeRun(row: RunRecord & { optimizationApplied?: boolean | number }): RunRecord {
    return { ...row, optimizationApplied: Boolean(row.optimizationApplied) };
  }

  getPendingRuns(): RunRecord[] {
    return (this.db.prepare(`SELECT id, provider, mode, started_at AS startedAt, ended_at AS endedAt,
        exit_code AS exitCode, cli_version AS cliVersion, optimization_applied AS optimizationApplied,
        optimization_profile AS optimizationProfile, collection_state AS collectionState,
        task_kind AS taskKind, outcome FROM runs
        WHERE collection_state = 'pending' AND ended_at IS NOT NULL ORDER BY ended_at ASC`)
      .all() as unknown as Array<RunRecord & { optimizationApplied?: number }>).map((row) => this.normalizeRun(row));
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
      optimization_profile AS optimizationProfile, collection_state AS collectionState,
      task_kind AS taskKind, outcome FROM runs WHERE id = ?`).get(id) as RunRecord & { optimizationApplied?: number } | undefined;
    return row ? this.normalizeRun(row) : undefined;
  }

  aggregateSince(since: string): AggregateRow[] {
    return this.db.prepare(`
      WITH usage AS (
        SELECT run_id, SUM(COALESCE(input_new, 0)) AS input_new, SUM(COALESCE(input_cached, 0)) AS input_cached,
          SUM(COALESCE(cache_created, 0)) AS cache_created, SUM(COALESCE(output, 0)) AS output,
          SUM(COALESCE(reasoning, 0)) AS reasoning, SUM(COALESCE(model_calls, 0)) AS model_calls
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
        SUM(CASE WHEN r.collection_state = 'unavailable' THEN 1 ELSE 0 END) AS unavailableSessions
      FROM runs r LEFT JOIN measured m ON m.run_id = r.id
      WHERE r.started_at >= ?
      GROUP BY r.provider
      ORDER BY r.provider
    `).all(since) as unknown as MeasurementCoverage[];
  }

  sessionSummariesSince(since: string): SessionSummary[] {
    return (this.db.prepare(`
      WITH usage AS (
        SELECT run_id, SUM(COALESCE(input_new, 0)) AS input_new, SUM(COALESCE(input_cached, 0)) AS input_cached,
          SUM(COALESCE(cache_created, 0)) AS cache_created, SUM(COALESCE(output, 0)) AS output,
          SUM(COALESCE(reasoning, 0)) AS reasoning
        FROM usage_records GROUP BY run_id
      ), events AS (
        SELECT run_id,
          SUM(CASE WHEN type = 'compaction' THEN count ELSE 0 END) AS compactions,
          SUM(CASE WHEN type = 'retry' THEN count ELSE 0 END) AS retries
        FROM session_events GROUP BY run_id
      )
      SELECT r.id, r.provider, r.mode, r.optimization_applied AS optimizationApplied,
        r.optimization_profile AS optimizationProfile, r.task_kind AS taskKind, r.outcome,
        MAX(0, strftime('%s', r.ended_at) - strftime('%s', r.started_at)) AS durationSeconds,
        u.input_new AS inputNew, u.input_cached AS inputCached, u.cache_created AS cacheCreated,
        u.output AS output, u.reasoning AS reasoning,
        COALESCE(e.compactions, 0) AS compactions, COALESCE(e.retries, 0) AS retries
      FROM runs r JOIN usage u ON u.run_id = r.id LEFT JOIN events e ON e.run_id = r.id
      WHERE r.started_at >= ? AND r.ended_at IS NOT NULL
      ORDER BY r.provider, r.task_kind, r.started_at
    `).all(since) as unknown as Array<Omit<SessionSummary, "optimizationApplied"> & { optimizationApplied: number }>).map((row) => ({
      ...row,
      optimizationApplied: Boolean(row.optimizationApplied)
    }));
  }

  close(): void {
    this.db.close();
  }
}
