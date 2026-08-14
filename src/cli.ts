#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getPaths } from "./paths.js";
import { install, uninstall } from "./installer.js";
import { collectPendingRuns } from "./collector.js";
import { buildReport, reportMarkdown } from "./report.js";
import { runProvider } from "./launcher.js";
import { setMode } from "./config.js";
import { TelemetryDatabase } from "./database.js";
import { PROVIDERS, type Provider, type TaskKind, type TaskOutcome } from "./types.js";

const HELP = `TokenPilot — local-first CLI telemetry

Usage:
  tokenpilot install [--dry-run] [--no-shell-config] [--no-agent] [--no-skills]
  tokenpilot uninstall [--dry-run]
  tokenpilot mode <observe|balanced|deep|off>
  tokenpilot agent [--once] [--interval <seconds>]
  tokenpilot collect
  tokenpilot sessions [--days <1-365>] [--unclassified]
  tokenpilot classify <run-id> --kind <feature|bugfix|research|operations|benchmark|other> --outcome <completed|rework|abandoned>
  tokenpilot report [--days <1-365>] [--format <md|json>]
  tokenpilot status

Daily usage after install is unchanged: claude, codex, grok, or kimi.
Immediate bypass: TOKENPILOT_BYPASS=1 codex
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function isProvider(value: string | undefined): value is Provider {
  return Boolean(value && (PROVIDERS as readonly string[]).includes(value));
}

function printPlan(plan: ReturnType<typeof install>): void {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

async function runAgent(args: string[]): Promise<number> {
  const paths = getPaths();
  const interval = Number(flag(args, "--interval") ?? 60);
  if (!Number.isInteger(interval) || interval < 10 || interval > 3_600) throw new Error("--interval must be a whole number between 10 and 3600");
  const once = has(args, "--once");
  const collect = () => {
    try {
      return collectPendingRuns(paths);
    } catch {
      // A background collector must not leak a provider path or terminate the
      // LaunchAgent when its local state is unavailable.
      return { collected: 0, unavailable: 0 };
    }
  };
  if (once) {
    const result = collect();
    process.stdout.write(`TokenPilot collector: ${result.collected} collected, ${result.unavailable} unavailable.\n`);
    return 0;
  }
  collect();
  const timer = setInterval(collect, interval * 1_000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise(() => undefined);
}

function status(): void {
  const paths = getPaths();
  const database = new TelemetryDatabase(paths);
  database.close();
  process.stdout.write(`TokenPilot state: ${paths.dataDir}\nTelemetry database: ${paths.databaseFile}\nShim directory: ${paths.shimDir}\n`);
}

function daysArgument(args: string[]): number {
  const days = Number(flag(args, "--days") ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be a whole number between 1 and 365");
  return days;
}

function sessions(args: string[]): void {
  const paths = getPaths();
  const days = daysArgument(args);
  if (!fs.existsSync(paths.databaseFile)) {
    process.stdout.write("No local TokenPilot sessions yet.\n");
    return;
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  const database = new TelemetryDatabase(paths, { readOnly: true });
  try {
    const rows = database.recentRunsSince(since, has(args, "--unclassified"));
    if (rows.length === 0) {
      process.stdout.write("No matching TokenPilot sessions.\n");
      return;
    }
    process.stdout.write("Run ID                              Provider  Started                   Mode      Policy                 Task        Outcome\n");
    for (const row of rows) {
      const policy = row.optimizationProfile ?? row.comparisonProfile ?? "none";
      process.stdout.write(`${row.id}  ${row.provider.padEnd(8)}  ${row.startedAt.slice(0, 19)}  ${row.mode.padEnd(8)}  ${policy.padEnd(21)}  ${row.taskKind.padEnd(10)}  ${row.outcome}\n`);
    }
  } finally {
    database.close();
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  const paths = getPaths();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "__shim") {
    const provider = args[1];
    if (!isProvider(provider)) throw new Error("Invalid TokenPilot shim provider");
    return runProvider(provider, args.slice(2), paths);
  }
  if (command === "install") {
    const plan = install(paths, {
      dryRun: has(args, "--dry-run"),
      noShellConfig: has(args, "--no-shell-config"),
      noAgent: has(args, "--no-agent"),
      noSkills: has(args, "--no-skills"),
      executable: fileURLToPath(import.meta.url)
    });
    printPlan(plan);
    return 0;
  }
  if (command === "uninstall") {
    printPlan(uninstall(paths, has(args, "--dry-run")));
    return 0;
  }
  if (command === "mode") {
    const mode = args[1];
    if (!["observe", "balanced", "deep", "off"].includes(mode ?? "")) throw new Error("Mode must be observe, balanced, deep, or off");
    setMode(paths, mode as "observe" | "balanced" | "deep" | "off");
    process.stdout.write(`TokenPilot mode: ${mode}\n`);
    return 0;
  }
  if (command === "agent") return runAgent(args.slice(1));
  if (command === "collect") return runAgent(["--once"]);
  if (command === "sessions") {
    sessions(args.slice(1));
    return 0;
  }
  if (command === "classify") {
    const id = args[1];
    const kind = flag(args, "--kind") as TaskKind | undefined;
    const outcome = flag(args, "--outcome") as TaskOutcome | undefined;
    if (!id || !["feature", "bugfix", "research", "operations", "benchmark", "other"].includes(kind ?? "") || !["completed", "rework", "abandoned"].includes(outcome ?? "")) {
      throw new Error("Use tokenpilot classify <run-id> --kind <feature|bugfix|research|operations|benchmark|other> --outcome <completed|rework|abandoned>");
    }
    const database = new TelemetryDatabase(paths);
    try {
      if (!database.classify(id, kind as TaskKind, outcome as TaskOutcome)) throw new Error(`Run not found: ${id}`);
    } finally {
      database.close();
    }
    process.stdout.write(`Classified ${id}.\n`);
    return 0;
  }
  if (command === "report") {
    const days = daysArgument(args);
    const report = buildReport(paths, days);
    const format = flag(args, "--format") ?? "md";
    if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (format === "md") process.stdout.write(reportMarkdown(report));
    else throw new Error("--format must be md or json");
    return 0;
  }
  if (command === "status") {
    status();
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  process.stderr.write(`TokenPilot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
