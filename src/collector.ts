import type { RunRecord } from "./types.js";
import { TelemetryDatabase } from "./database.js";
import type { TokenPilotPaths } from "./paths.js";

/**
 * No shipped provider adapter can prove that an ambient local session file is
 * the personal wrapper run. Reading by timestamp risks copying company metrics
 * into personal storage, so V1 deliberately records no ambient session files.
 * A future adapter must supply a provider-documented run correlation before it
 * is allowed to add usage to the database.
 */
export function collectRun(_paths: TokenPilotPaths, database: TelemetryDatabase, run: RunRecord): boolean {
  if (database.hasUsage(run.id)) {
    database.markCollection(run.id, "collected");
    return true;
  }
  database.markCollection(run.id, "unavailable", "collector-unavailable");
  return false;
}

export function collectPendingRuns(paths: TokenPilotPaths): { collected: number; unavailable: number } {
  const database = new TelemetryDatabase(paths);
  try {
    let collected = 0;
    let unavailable = 0;
    for (const run of database.getPendingRuns()) {
      if (collectRun(paths, database, run)) collected += 1;
      else unavailable += 1;
    }
    return { collected, unavailable };
  } finally {
    database.close();
  }
}
