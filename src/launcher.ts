import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getAdapter } from "./adapters/index.js";
import { ensureConfig } from "./config.js";
import { TelemetryDatabase } from "./database.js";
import { planForInstalledCli, planFromHelp } from "./optimization.js";
import type { TokenPilotPaths } from "./paths.js";
import { startClaudeMetricsReceiver, type ClaudeMetricsReceiver } from "./telemetry/claude.js";
import { CodexExecTokenParser, isCodexExec, startCodexMetricsReceiver, type CodexMetricsReceiver } from "./telemetry/codex.js";
import { GrokJsonUsageParser, isGrokJsonSingle } from "./telemetry/grok.js";
import type { Provider, RunMode } from "./types.js";

const PASSTHROUGH_ARGUMENTS = new Set([
  "login", "logout", "auth", "--help", "-h", "--version", "-V", "version",
  // Provider maintenance and configuration commands are not AI sessions.
  "update", "upgrade", "doctor", "completion", "completions", "mcp", "plugin", "plugins",
  "config", "setup", "models", "sessions", "trace", "inspect", "du", "leader"
]);
const PROVIDER_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function isPassthrough(args: string[]): boolean {
  return args.length > 0 && PASSTHROUGH_ARGUMENTS.has(args[0]);
}

function trustedExecutable(candidate: string): string | undefined {
  try {
    const resolved = fs.realpathSync(candidate);
    fs.accessSync(resolved, fs.constants.X_OK);
    const binary = fs.statSync(resolved);
    const directory = fs.statSync(path.dirname(resolved));
    const currentUid = process.getuid?.() ?? os.userInfo().uid;
    const protectedOwner = binary.uid === currentUid || binary.uid === 0;
    const protectedDirectory = directory.uid === currentUid || directory.uid === 0;
    const binaryWritableByOthers = (binary.mode & 0o022) !== 0;
    const directoryWritableByOthers = (directory.mode & 0o022) !== 0;
    return binary.isFile() && directory.isDirectory() && protectedOwner && protectedDirectory
      && !binaryWritableByOthers && !directoryWritableByOthers
      && !hasMacAcl(resolved) && !hasMacAcl(path.dirname(resolved)) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** macOS ACLs can grant writes even when POSIX mode bits are restrictive. */
function hasMacAcl(target: string): boolean {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("/bin/ls", ["-lde", target], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return true;
  // `ls -e` prints one extra line for every ACL entry. Refuse all ACLs rather
  // than attempting to infer whether a named principal can modify the file.
  return result.stdout.trim().split(/\r?\n/).length > 1;
}

function providerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name !== "PATH" && !name.startsWith("TOKENPILOT_")));
  return { ...environment, ...overrides, PATH: PROVIDER_PATH };
}

function canonicalDirectory(directory: string): string {
  try {
    return fs.realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function shimDirectories(paths: TokenPilotPaths): Set<string> {
  return new Set([canonicalDirectory(paths.shimDir)]);
}

function isShimBinary(candidate: string, directories: Set<string>): boolean {
  return directories.has(canonicalDirectory(path.dirname(candidate)));
}

export function findOriginalBinary(provider: Provider, paths: TokenPilotPaths, pathValue = process.env.PATH ?? ""): string | undefined {
  const excludedDirectories = shimDirectories(paths);

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const resolvedDir = canonicalDirectory(directory);
    if (excludedDirectories.has(resolvedDir)) continue;
    const candidate = path.join(resolvedDir, provider);
    const trusted = trustedExecutable(candidate);
    if (trusted && !isShimBinary(trusted, excludedDirectories)) return trusted;
  }
  return undefined;
}

function binaryVersion(binary: string): string | undefined {
  const trusted = trustedExecutable(binary);
  if (!trusted) return undefined;
  const result = spawnSync(trusted, ["--version"], {
    encoding: "utf8",
    timeout: 4_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: providerEnvironment()
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.match(/\b\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?\b/)?.[0];
}

function supportsCodexSessionConfiguration(binary: string): boolean {
  const trusted = trustedExecutable(binary);
  if (!trusted) return false;
  const result = spawnSync(trusted, ["--help"], {
    encoding: "utf8",
    timeout: 4_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: providerEnvironment()
  });
  return !result.error && result.status === 0 && result.stdout.includes("--config");
}

interface ChildObservation {
  consume(chunk: Buffer): void;
}

function launchChild(binary: string, args: string[], environment = providerEnvironment(), observation?: ChildObservation): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const trusted = trustedExecutable(binary);
    if (!trusted) {
      reject(new Error("Provider executable no longer meets TokenPilot trust checks"));
      return;
    }
    const child = spawn(trusted, args, {
      // Codex `exec` is non-interactive; normal provider sessions retain their
      // inherited TTY streams exactly as before.
      stdio: observation ? ["inherit", "pipe", "pipe"] : "inherit",
      env: environment,
      cwd: process.cwd()
    });
    let settled = false;
    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.once("SIGINT", () => forward("SIGINT"));
    process.once("SIGTERM", () => forward("SIGTERM"));
    if (observation) {
      child.stdout?.on("data", (chunk: Buffer) => {
        observation.consume(chunk);
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        observation.consume(chunk);
        process.stderr.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
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
  // Authentication and support commands always pass through without a database record.
  if (bypass || isPassthrough(args)) {
    const result = await launchChild(binary, args);
    return result ?? 1;
  }

  let database: TelemetryDatabase | undefined;
  let runId: string | undefined;
  let launchArgs = args;
  let launchEnvironment = providerEnvironment();
  let claudeMetrics: ClaudeMetricsReceiver | undefined;
  let codexOtelMetrics: CodexMetricsReceiver | undefined;
  const codexExecMetrics = provider === "codex" && isCodexExec(args) ? new CodexExecTokenParser() : undefined;
  const grokMetrics = provider === "grok" && isGrokJsonSingle(args) ? new GrokJsonUsageParser() : undefined;
  try {
    const config = ensureConfig(paths);
    let mode = config.defaultMode;
    if (mode === "off") {
      // The launch itself happens below, outside the optional telemetry setup.
      launchArgs = args;
    } else {
      const trusted = trustedExecutable(binary);
      if (!trusted) throw new Error("Provider executable no longer meets TokenPilot trust checks");
      database = new TelemetryDatabase(paths);
      const experiment = config.defaultMode === "balanced"
        ? planForInstalledCli(provider, "balanced", trusted, providerEnvironment(), (candidate) => trustedExecutable(candidate) !== undefined)
        : undefined;
      if (mode === "balanced") mode = database.allocateBalancedMode(provider);
      const optimization = mode === "balanced" && experiment
        ? experiment
        : planForInstalledCli(provider, mode, trusted, providerEnvironment(), (candidate) => trustedExecutable(candidate) !== undefined);
      if (mode === "balanced" && optimization.applied) {
        process.stderr.write(`TokenPilot: balanced optimization active for ${provider} (${optimization.summary}).\n`);
      } else if (mode === "balanced") {
        process.stderr.write(`TokenPilot: ${optimization.unavailableReason}; starting ${provider} without injected settings.\n`);
      }

      runId = randomUUID();
      database.createRun({
        id: runId,
        provider,
        mode,
        startedAt: new Date().toISOString(),
        cliVersion: binaryVersion(trusted),
        optimizationApplied: optimization.applied,
        optimizationProfile: optimization.profile,
        comparisonProfile: experiment?.profile,
        collectionState: "pending",
        taskKind: "unknown",
        outcome: "unknown"
      });
      if (provider === "claude") {
        claudeMetrics = await startClaudeMetricsReceiver(database, runId);
        launchEnvironment = providerEnvironment(claudeMetrics.environment);
      }
      if (provider === "codex" && supportsCodexSessionConfiguration(trusted)) {
        // Codex's documented OTLP configuration is per invocation. If a
        // local receiver cannot start, preserve the existing `exec` parser
        // rather than failing the provider session or touching user config.
        try {
          codexOtelMetrics = await startCodexMetricsReceiver(database, runId);
        } catch {
          codexOtelMetrics = undefined;
        }
      }
      launchArgs = [...(codexOtelMetrics?.args ?? []), ...optimization.args, ...args];
    }
  } catch {
    // All optional state, telemetry, and optimization failures fail open.
    process.stderr.write(`TokenPilot: telemetry unavailable; starting ${provider} normally.\n`);
    database?.close();
    database = undefined;
    runId = undefined;
    await claudeMetrics?.close().catch(() => undefined);
    claudeMetrics = undefined;
    await codexOtelMetrics?.close().catch(() => undefined);
    codexOtelMetrics = undefined;
    launchArgs = args;
  }

  try {
    const observer = codexExecMetrics ?? grokMetrics;
    const code = await launchChild(binary, launchArgs, launchEnvironment, observer ? { consume: (chunk) => observer.accept(chunk) } : undefined);
    await claudeMetrics?.close().catch(() => undefined);
    await codexOtelMetrics?.close().catch(() => undefined);
    if (database && runId) {
      try {
        database.finishRun(runId, code, new Date().toISOString());
        if (provider === "claude") database.markCollection(runId, database.hasUsage(runId) ? "collected" : "unavailable");
        if (provider === "codex") {
          // OTLP gives interactive and exec sessions category-level metrics.
          // Preserve the old `exec` total only when the receiver did not
          // deliver a correlated sample, never double-count both sources.
          const total = codexExecMetrics?.finish();
          if (!database.hasUsage(runId) && total !== undefined) {
            database.addUsage({ runId, observedAt: new Date().toISOString(), source: "codex-cli-reported-total-v1", reportedTotal: total });
          }
          // Leave a no-sample run pending for the existing local collector to
          // mark unavailable. This preserves a single collection lifecycle
          // across current and older Codex CLI versions.
          if (database.hasUsage(runId)) database.markCollection(runId, "collected");
        }
        if (provider === "grok") {
          const usage = grokMetrics?.finish();
          if (usage) {
            database.addUsage({ runId, observedAt: new Date().toISOString(), source: "grok-cli-json-usage-v1", ...usage });
            database.markCollection(runId, "collected");
          }
        }
      } catch {
        process.stderr.write("TokenPilot: telemetry completion unavailable.\n");
      }
    }
    return code ?? 1;
  } finally {
    await claudeMetrics?.close().catch(() => undefined);
    await codexOtelMetrics?.close().catch(() => undefined);
    database?.close();
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
