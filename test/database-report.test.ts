import { describe, expect, it } from "vitest";
import { TelemetryDatabase } from "../src/database.js";
import { buildReport, reportMarkdown } from "../src/report.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("aggregate reporting", () => {
  it("groups only aggregate numeric data by provider, mode, and task kind", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    const now = new Date().toISOString();
    database.createRun({ id: "run-1", provider: "codex", mode: "observe", startedAt: now, endedAt: now, exitCode: 0, collectionState: "pending", taskKind: "bugfix", outcome: "completed" });
    database.addUsage({ runId: "run-1", observedAt: now, source: "codex", inputNew: 10, inputCached: 100, output: 4 });
    database.addEvent({ runId: "run-1", observedAt: now, source: "codex", type: "retry", count: 1 });
    database.close();

    const report = buildReport(paths, 7);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ provider: "codex", taskKind: "bugfix", sessions: 1, inputNew: 10, inputCached: 100, retries: 1 });
    expect(reportMarkdown(report)).toContain("codex");
    cleanup(paths);
  });
});
