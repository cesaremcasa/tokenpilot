import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getAdapter } from "./adapters/index.js";
import { ensureConfig, rememberProviderPath, selectMode } from "./config.js";
import { TelemetryDatabase } from "./database.js";
import { planForInstalledCli, planFromHelp } from "./optimization.js";
import type { TokenPilotPaths } from "./paths.js";
import type { Provider, RunMode } from "./types.js";

const PASSTHROUGH_ARGUMENTS = new Set(["login", "logout", "auth", "--help", "-h", "--version", "-V", "version"]);

export function isPassthrough(args: string[]): boolean {
  return args.length > 0 && PASSTHROUGH_ARGUMENTS.has(args[0]);
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function canonicalDirectory(directory: string): string {
  try {
    return fs.realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function shimDirectories(paths: TokenPilotPaths): Set<string> {
  const directories = [paths.shimDir, process.env.TOKENPILOT_SHIM_DIR].filter((item): item is string => Boolean(item));
  return new Set(directories.map(canonicalDirectory));
}

function isShimBinary(candidate: string, directories: Set<string>): boolean {
  return directories.has(canonicalDirectory(path.dirname(candidate)));
}

export function findOriginalBinary(provider: Provider, paths: TokenPilotPaths, pathValue = process.env.PATH ?? ""): string | undefined {
  const config = ensureConfig(paths);
  const excludedDirectories = shimDirectories(paths);
  const remembered = config.providers[provider]?.originalPath;
  if (remembered && isExecutable(remembered) && !isShimBinary(remembered, excludedDirectories)) return remembered;

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const resolvedDir = canonicalDirectory(directory);
    if (excludedDirectories.has(resolvedDir)) continue;
    const candidate = path.join(resolvedDir, provider);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function binaryVersion(binary: string): string | undefined {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 4_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim().split(/\r?\n/)[0]?.slice(0, 200);
}

function launchChild(binary: string, args: string[], paths: TokenPilotPaths): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const excludedDirectories = shimDirectories(paths);
    const childPath = (process.env.PATH ?? "").split(path.delimiter)
      .filter((directory) => directory && !excludedDirectories.has(canonicalDirectory(directory)))
      .join(path.delimiter);
    const child = spawn(binary, args, {
      stdio: "inherit",
      env: { ...process.env, PATH: childPath, TOKENPILOT_SHIM_DIR: "" },
      cwd: process.cwd()
    });
    let settled = false;
    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.once("SIGINT", () => forward("SIGINT"));
    process.once("SIGTERM", () => forward("SIGTERM"));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    });
  });
}

export async function runProvider(provider: Provider, args: string[], paths: TokenPilotPaths): Promise<number> {
  const binary = findOriginalBinary(provider, paths);
  if (!binary) {
    process.stderr.write(`TokenPilot: '${provider}' was not found outside ${paths.shimDir}. Run tokenpilot install after installing the provider CLI.\n`);
    return 127;
  }

  const bypass = process.env.TOKENPILOT_BYPASS === "1";
  const config = ensureConfig(paths);
  const mode = selectMode(config, bypass);
  // Authentication and support commands always pass through without a database record.
  if (mode === "off" || isPassthrough(args)) {
    const result = await launchChild(binary, args, paths);
    return result ?? 1;
  }

  const optimization = planForInstalledCli(provider, mode, binary);
  if (mode === "balanced" && optimization.applied) {
    process.stderr.write(`TokenPilot: balanced optimization active for ${provider} (${optimization.summary}).\n`);
  } else if (mode === "balanced") {
    process.stderr.write(`TokenPilot: ${optimization.unavailableReason}; starting ${provider} without injected settings.\n`);
  }

  const runId = randomUUID();
  const database = new TelemetryDatabase(paths);
  try {
    database.createRun({
      id: runId,
      provider,
      mode,
      startedAt: new Date().toISOString(),
      cliVersion: binaryVersion(binary),
      optimizationApplied: optimization.applied,
      optimizationProfile: optimization.profile,
      collectionState: "pending",
      taskKind: "unknown",
      outcome: "unknown"
    });
    rememberProviderPath(paths, provider, binary);
  } catch (error) {
    // Fail open: a telemetry failure must never prevent access to the original CLI.
    process.stderr.write(`TokenPilot: telemetry unavailable; starting ${provider} normally.\n`);
    database.close();
    const result = await launchChild(binary, [...optimization.args, ...args], paths);
    return result ?? 1;
  }

  try {
    const code = await launchChild(binary, [...optimization.args, ...args], paths);
    database.finishRun(runId, code, new Date().toISOString());
    return code ?? 1;
  } finally {
    database.close();
  }
}

export function providerCapabilities(provider: Provider): string {
  return getAdapter(provider).capabilities.notes;
}

export function profileArguments(provider: Provider, mode: RunMode, help = ""): string[] {
  // Exported for deterministic tests and external adapter review. Runtime calls
  // planForInstalledCli so an upgraded or incompatible CLI is never guessed.
  return planFromHelp(provider, mode, help).args;
}
