import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAdapter } from "./adapters/index.js";
import type { ParsedTelemetry, RunRecord, UsageMetrics } from "./types.js";
import { TelemetryDatabase } from "./database.js";
import type { TokenPilotPaths } from "./paths.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const COLLECTION_SLOP_MS = 30_000;

function walkJsonl(root: string, output: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(target, output);
    else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) output.push(target);
  }
  return output;
}

function addMetrics(target: UsageMetrics, next: UsageMetrics): void {
  for (const key of Object.keys(next) as Array<keyof UsageMetrics>) {
    const value = next[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}

function readRelevantTelemetry(file: string, run: RunRecord): ParsedTelemetry[] {
  const stat = fs.statSync(file);
  const start = new Date(run.startedAt).getTime() - COLLECTION_SLOP_MS;
  const end = new Date(run.endedAt ?? run.startedAt).getTime() + COLLECTION_SLOP_MS;
  if (stat.mtimeMs < start || stat.mtimeMs > end || stat.size > MAX_FILE_BYTES) return [];

  const contents = fs.readFileSync(file, "utf8");
  return contents.split(/\r?\n/).flatMap((line) => {
    const parsed = getAdapter(run.provider).parseTelemetryLine(line);
    return parsed ? [parsed] : [];
  });
}

/**
 * Collection is deliberately best-effort: uncorrelated concurrent sessions are skipped rather than
 * risking a misleading record. Provider-specific correlation can replace this in a later adapter.
 */
export function collectRun(paths: TokenPilotPaths, database: TelemetryDatabase, run: RunRecord, homeDir = os.homedir()): boolean {
  const adapter = getAdapter(run.provider);
  const telemetry = adapter.telemetryRoots(homeDir)
    .flatMap((root) => walkJsonl(root))
    .flatMap((file) => readRelevantTelemetry(file, run));

  if (telemetry.length === 0) {
    database.markCollection(run.id, "unavailable");
    return false;
  }

  const usage: UsageMetrics = {};
  const events = new Map<string, number>();
  for (const item of telemetry) {
    if (item.usage) addMetrics(usage, item.usage);
    for (const event of item.events) events.set(event.type, (events.get(event.type) ?? 0) + event.count);
  }

  if (Object.keys(usage).length > 0) {
    database.addUsage({ runId: run.id, observedAt: run.endedAt ?? new Date().toISOString(), source: adapter.provider, ...usage });
  }
  for (const [type, count] of events) {
    database.addEvent({ runId: run.id, observedAt: run.endedAt ?? new Date().toISOString(), source: adapter.provider, type: type as "compaction" | "retry" | "model_switch", count });
  }
  database.markCollection(run.id, Object.keys(usage).length > 0 ? "collected" : "unavailable");
  return Object.keys(usage).length > 0;
}

export function collectPendingRuns(paths: TokenPilotPaths, homeDir = os.homedir()): { collected: number; unavailable: number } {
  const database = new TelemetryDatabase(paths);
  try {
    let collected = 0;
    let unavailable = 0;
    for (const run of database.getPendingRuns()) {
      if (collectRun(paths, database, run, homeDir)) collected += 1;
      else unavailable += 1;
    }
    return { collected, unavailable };
  } finally {
    database.close();
  }
}
