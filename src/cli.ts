#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getPaths } from "./paths.js";
import { install, uninstall } from "./installer.js";
import { collectPendingRuns } from "./collector.js";
import { buildReport, filterReportByProvider, renderReportMarkdown, type ReportView } from "./report.js";
import { runProvider } from "./launcher.js";
import { addPricing, disablePricing, ensureConfig, listPricing, setMode, setPricing } from "./config.js";
import { TelemetryDatabase } from "./database.js";
import { doctor, doctorMarkdown } from "./doctor.js";
import { renderSessions } from "./sessions.js";
import { PROVIDERS, type PricingProfile, type Provider, type TaskKind, type TaskOutcome } from "./types.js";
import { TOKENPILOT_VERSION } from "./version.js";

const HELP = `TokenPilot — local-first CLI telemetry

Usage:
  tokenpilot --version
  tokenpilot install [--dry-run] [--no-shell-config] [--no-agent] [--no-skills]
  tokenpilot uninstall [--dry-run]
  tokenpilot doctor [--format <md|json>]
  tokenpilot mode <observe|balanced|deep|off>
  tokenpilot pricing list
  tokenpilot pricing add <provider> <profile> --label <label> --version <version> --input-usd-per-million <rate> --cached-input-usd-per-million <rate> --cache-creation-usd-per-million <rate> --output-usd-per-million <rate> [--reasoning-usd-per-million <rate>]
  tokenpilot pricing set <provider> <profile>
  tokenpilot pricing off <provider>
  tokenpilot agent [--once] [--interval <seconds>]
  tokenpilot collect
  tokenpilot sessions [--days <1-365>] [--unclassified]
  tokenpilot classify <run-id> --kind <feature|bugfix|research|operations|benchmark|other> --outcome <completed|rework|abandoned>
  tokenpilot report [--days <1-365>] [--provider <claude|codex|grok|kimi>] [--view <summary|detail|diagnostics>] [--format <md|json>]
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

function requiredFlag(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function numericFlag(args: string[], name: string, optional = false): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined && optional) return undefined;
  if (raw === undefined) throw new Error(`Missing ${name}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function pricing(args: string[], paths: ReturnType<typeof getPaths>): void {
  const operation = args[0];
  if (operation === "list") {
    const profiles = listPricing(paths);
    const selected = ensureConfig(paths).activePricing;
    if (profiles.length === 0) {
      process.stdout.write("No local API-equivalent price profiles are configured. Add one manually; TokenPilot never fetches prices or captures a model automatically.\n");
      return;
    }
    process.stdout.write("Provider  Active  Profile                         Version                         Label\n");
    for (const profile of profiles) {
      const active = selected[profile.provider] === profile.id ? "yes" : "no";
      process.stdout.write(`${profile.provider.padEnd(8)}  ${active.padEnd(6)}  ${profile.id.padEnd(30)}  ${profile.version.padEnd(30)}  ${profile.label}\n`);
    }
    return;
  }
  const provider = args[1];
  if (!isProvider(provider)) throw new Error("Pricing provider must be claude, codex, grok, or kimi");
  if (operation === "set") {
    const id = args[2];
    if (!id) throw new Error("Use tokenpilot pricing set <provider> <profile>");
    setPricing(paths, provider, id);
    process.stdout.write(`TokenPilot API-equivalent price profile for ${provider}: ${id}\n`);
    return;
  }
  if (operation === "off") {
    disablePricing(paths, provider);
    process.stdout.write(`TokenPilot API-equivalent price conversion disabled for ${provider}.\n`);
    return;
  }
  if (operation === "add") {
    const id = args[2];
    if (!id) throw new Error("Use tokenpilot pricing add <provider> <profile> with the required rate flags");
    const profile: PricingProfile = {
      id,
      provider,
      label: requiredFlag(args, "--label"),
      version: requiredFlag(args, "--version"),
      currency: "USD",
      rates: {
        inputUsdPerMillion: numericFlag(args, "--input-usd-per-million")!,
        cachedInputUsdPerMillion: numericFlag(args, "--cached-input-usd-per-million")!,
        cacheCreationUsdPerMillion: numericFlag(args, "--cache-creation-usd-per-million")!,
        outputUsdPerMillion: numericFlag(args, "--output-usd-per-million")!,
        reasoningUsdPerMillion: numericFlag(args, "--reasoning-usd-per-million", true)
      }
    };
    addPricing(paths, profile);
    process.stdout.write(`Saved local API-equivalent price profile ${id} for ${provider}. Select it with tokenpilot pricing set ${provider} ${id}.\n`);
    return;
  }
  throw new Error("Use tokenpilot pricing list, add, set, or off");
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
    const rows = database.auditableSessionsSince(since, has(args, "--unclassified"));
    if (rows.length === 0) {
      process.stdout.write("No matching TokenPilot sessions.\n");
      return;
    }
    process.stdout.write(renderSessions(rows));
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
  if (command === "version" || command === "--version" || command === "-V") {
    process.stdout.write(`tokenpilot ${TOKENPILOT_VERSION}\n`);
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
  if (command === "doctor") {
    const format = flag(args, "--format") ?? "md";
    const result = doctor(paths);
    if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (format === "md") process.stdout.write(doctorMarkdown(result));
    else throw new Error("--format must be md or json");
    return result.ready ? 0 : 1;
  }
  if (command === "mode") {
    const mode = args[1];
    if (!["observe", "balanced", "deep", "off"].includes(mode ?? "")) throw new Error("Mode must be observe, balanced, deep, or off");
    setMode(paths, mode as "observe" | "balanced" | "deep" | "off");
    process.stdout.write(`TokenPilot mode: ${mode}\n`);
    return 0;
  }
  if (command === "pricing") {
    pricing(args.slice(1), paths);
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
    const requestedProvider = flag(args, "--provider");
    if (requestedProvider !== undefined && !isProvider(requestedProvider)) {
      throw new Error("--provider must be claude, codex, grok, or kimi");
    }
    const completeReport = buildReport(paths, days);
    const report = requestedProvider === undefined ? completeReport : filterReportByProvider(completeReport, requestedProvider);
    const format = flag(args, "--format") ?? "md";
    const view = flag(args, "--view") ?? "summary";
    if (!(["summary", "detail", "diagnostics"] as const).includes(view as ReportView)) {
      throw new Error("--view must be summary, detail, or diagnostics");
    }
    if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (format === "md") process.stdout.write(renderReportMarkdown(report, view as ReportView));
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
