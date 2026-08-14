import type { AggregateRow } from "./types.js";
import { TelemetryDatabase } from "./database.js";
import type { TokenPilotPaths } from "./paths.js";

export interface Report {
  generatedAt: string;
  since: string;
  rows: AggregateRow[];
}

export function buildReport(paths: TokenPilotPaths, days: number): Report {
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("--days must be between 1 and 365");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  const database = new TelemetryDatabase(paths);
  try {
    return { generatedAt: new Date().toISOString(), since, rows: database.aggregateSince(since) };
  } finally {
    database.close();
  }
}

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function reportMarkdown(report: Report): string {
  const lines = [
    "# TokenPilot — Personal telemetry report",
    "",
    `Generated: ${report.generatedAt}`,
    `Window starts: ${report.since}`,
    "",
    "> This report contains aggregate numeric telemetry only. Do not compare raw token totals across providers.",
    "",
    "| Provider | Mode | Task type | Sessions | Complete | Rework | Abandoned | New input | Cached input | Cache created | Output | Reasoning | Retries |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const row of report.rows) {
    lines.push(`| ${row.provider} | ${row.mode} | ${row.taskKind} | ${integer(row.sessions)} | ${integer(row.completed)} | ${integer(row.rework)} | ${integer(row.abandoned)} | ${integer(row.inputNew)} | ${integer(row.inputCached)} | ${integer(row.cacheCreated)} | ${integer(row.output)} | ${integer(row.reasoning)} | ${integer(row.retries)} |`);
  }
  if (report.rows.length === 0) lines.push("| — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |");
  lines.push("", "## Interpretation", "", "- `observe` establishes the personal baseline and must not change CLI behavior.", "- `balanced` is a randomized label until an adapter has been explicitly validated to inject provider-specific settings.", "- `off` writes no telemetry. `TOKENPILOT_BYPASS=1 <provider>` bypasses TokenPilot immediately.", "");
  return lines.join("\n");
}
