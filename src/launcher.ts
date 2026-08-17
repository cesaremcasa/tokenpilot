import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getAdapter } from "./adapters/index.js";
import { ensureConfig } from "./config.js";
import { TelemetryDatabase } from "./database.js";
import { planForInstalledCli, planFromHelp } from "./optimization.js";
import { pricingProfile } from "./pricing.js";
import { hasUnsafeMacAcl } from "./acl.js";
import type { TokenPilotPaths } from "./paths.js";
import { startClaudeMetricsReceiver, type ClaudeMetricsReceiver } from "./telemetry/claude.js";
import { CodexExecTokenParser, isCodexExec, startCodexMetricsReceiver, type CodexMetricsReceiver } from "./telemetry/codex.js";
import { GrokJsonUsageParser, isGrokJsonSingle, startGrokMetricsReceiver, supportsGrokExternalOtelVersion, type GrokMetricsReceiver } from "./telemetry/grok.js";
import type { Provider, RunMode } from "./types.js";

/** Homebrew on Apple Silicon uses user:admin 0775 for lib/bin, not a world-writable prefix. */
const MACOS_ADMIN_GID = 80;

const PASSTHROUGH_ARGUMENTS = new Set([
  "login", "logout", "auth", "--help", "-h", "--version", "-V", "version",
  // Provider maintenance and configuration commands are not AI sessions.
  "update", "upgrade", "doctor", "completion", "completions", "mcp", "plugin", "plugins",
  "config", "setup", "models", "sessions", "trace", "inspect", "du", "leader"
]);
const PROVIDER_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function isPassthrough(args: string[]): boolean {
  const sentinel = args.indexOf("--");
  const providerArguments = sentinel >= 0 ? args.slice(0, sentinel) : args;
  return providerArguments.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))
    || (providerArguments.length > 0 && PASSTHROUGH_ARGUMENTS.has(providerArguments[0]));
}

function trustedExecutable(candidate: string): string | undefined {
  try {
    const resolved = fs.realpathSync(candidate);
    fs.accessSync(resolved, fs.constants.X_OK);
    const binary = fs.statSync(resolved);
    const currentUid = process.getuid?.() ?? os.userInfo().uid;
    if (!trustedDirectoryTree(path.dirname(resolved), currentUid)) return undefined;
    const protectedOwner = binary.uid === currentUid || binary.uid === 0;
    const binaryWritableByOthers = (binary.mode & 0o022) !== 0;
    return binary.isFile() && protectedOwner && !binaryWritableByOthers && !hasUnsafeMacAcl(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A safe leaf directory is not enough: a writable, non-sticky ancestor can
 * replace that directory after validation and before the provider is spawned.
 */
function trustedDirectoryTree(directory: string, currentUid: number): boolean {
  const root = path.parse(directory).root;
  const segments = path.relative(root, directory).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    const stat = fs.statSync(current);
    const protectedOwner = stat.uid === currentUid || stat.uid === 0;
    const worldWritable = (stat.mode & 0o002) !== 0;
    const groupWritable = (stat.mode & 0o020) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    const homebrewAdminGroup = process.platform === "darwin" && stat.uid === currentUid && stat.gid === MACOS_ADMIN_GID;
    // Sticky world-writable directories such as /tmp stay admissible, matching
    // the previous audit rule. Non-sticky group-writable ancestors remain
    // rejected except Homebrew's user-owned admin group on macOS.
    const untrustedWrite = worldWritable ? !sticky : groupWritable && !sticky && !homebrewAdminGroup;
    if (!stat.isDirectory() || !protectedOwner || untrustedWrite || hasUnsafeMacAcl(current)) return false;
  }
  return true;
}

/**
 * Builds the intentionally narrow PATH used by a provider process.
 *
 * A CLI installed with `npm --global` commonly lives next to the Node runtime
 * that is executing TokenPilot.  That directory is not necessarily part of a
 * login shell's PATH (for example, a per-user Node 22 installation on Linux).
 * Keep it when it passes the same ownership and permission checks as every
 * provider executable; otherwise a `#!/usr/bin/env node` provider shim would
 * fail even after TokenPilot had safely found the real CLI.
 */
export function providerEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  originalBinary?: string,
  nodeExecutable = process.execPath
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name !== "PATH" && name !== "NODE_NO_WARNINGS" && !name.startsWith("TOKENPILOT_")));
  const directories: string[] = [];
  for (const executable of [originalBinary, nodeExecutable]) {
    if (!executable || !trustedExecutable(executable)) continue;
    const directory = canonicalDirectory(path.dirname(executable));
    if (!directories.includes(directory)) directories.push(directory);
  }
  for (const directory of PROVIDER_PATH.split(":")) {
    if (!directories.includes(directory)) directories.push(directory);
  }
  return { ...environment, ...overrides, PATH: directories.join(":") };
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

export function findOriginalBinary(
  provider: Provider,
  paths: TokenPilotPaths,
  pathValue = process.env.PATH ?? "",
  nodeExecutable = process.execPath
): string | undefined {
  const excludedDirectories = shimDirectories(paths);
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  // `npm --global` installs provider entrypoints next to its Node executable.
  // This fallback does not trust arbitrary state: the Node executable and the
  // candidate provider binary must each pass the ownership and mode checks.
  if (trustedExecutable(nodeExecutable)) directories.push(path.dirname(nodeExecutable));

  for (const directory of directories) {
    const resolvedDir = canonicalDirectory(directory);
    if (excludedDirectories.has(resolvedDir)) continue;
    const candidate = path.join(resolvedDir, provider);
    const trusted = trustedExecutable(candidate);
    if (trusted && !isShimBinary(trusted, excludedDirectories)) return trusted;
  }
  return undefined;
}

export function binaryVersion(binary: string): string | undefined {
  const trusted = trustedExecutable(binary);
  if (!trusted) return undefined;
  const result = spawnSync(trusted, ["--version"], {
    encoding: "utf8",
    timeout: 4_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: providerEnvironment({}, trusted)
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.match(/\b\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?\b/)?.[0];
}

export function supportsGrokExternalOtel(binary: string): boolean {
  return supportsGrokExternalOtelVersion(binaryVersion(binary));
}

function supportsCodexSessionConfiguration(binary: string): boolean {
  const trusted = trustedExecutable(binary);
  if (!trusted) return false;
  const result = spawnSync(trusted, ["--help"], {
    encoding: "utf8",
    timeout: 4_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: providerEnvironment({}, trusted)
  });
  return !result.error && result.status === 0 && result.stdout.includes("--config");
}

interface ChildObservation {
  consume(chunk: Buffer): void;
}

function launchChild(binary: string, args: string[], environment?: NodeJS.ProcessEnv, observation?: ChildObservation): Promise<number | null> {
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
      env: environment ?? providerEnvironment({}, trusted),
      cwd: process.cwd()
    });
    let settled = false;
    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    const removeSignalHandlers = () => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
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
    child.on("error", (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        removeSignalHandlers();
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
  let launchEnvironment = providerEnvironment({}, binary);
  let claudeMetrics: ClaudeMetricsReceiver | undefined;
  let codexOtelMetrics: CodexMetricsReceiver | undefined;
  let grokOtelMetrics: GrokMetricsReceiver | undefined;
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
      const version = binaryVersion(trusted);
      const experiment = config.defaultMode === "balanced"
        ? planForInstalledCli(provider, "balanced", trusted, providerEnvironment({}, trusted), (candidate) => trustedExecutable(candidate) !== undefined)
        : undefined;
      if (mode === "balanced") mode = database.allocateBalancedMode(provider);
      const optimization = mode === "balanced" && experiment
        ? experiment
        : planForInstalledCli(provider, mode, trusted, providerEnvironment({}, trusted), (candidate) => trustedExecutable(candidate) !== undefined);
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
        cliVersion: version,
        optimizationApplied: optimization.applied,
        optimizationProfile: optimization.profile,
        comparisonProfile: experiment?.profile,
        pricingProfile: pricingProfile(config, provider),
        collectionState: "pending",
        taskKind: "unknown",
        outcome: "unknown"
      });
      if (provider === "claude") {
        claudeMetrics = await startClaudeMetricsReceiver(database, runId);
        launchEnvironment = providerEnvironment(claudeMetrics.environment, trusted);
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
      if (provider === "grok" && supportsGrokExternalOtelVersion(binaryVersion(trusted))) {
        // Grok Build 1.0.3+ documents a content-free External OTEL v1 stream
        // for normal CLI/TTY sessions. Configure it only for this child.
        try {
          grokOtelMetrics = await startGrokMetricsReceiver(database, runId);
          launchEnvironment = providerEnvironment(grokOtelMetrics.environment, trusted);
        } catch {
          grokOtelMetrics = undefined;
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
    await grokOtelMetrics?.close().catch(() => undefined);
    grokOtelMetrics = undefined;
    launchArgs = args;
  }

  try {
    const observer = codexExecMetrics ?? grokMetrics;
    const code = await launchChild(binary, launchArgs, launchEnvironment, observer ? { consume: (chunk) => observer.accept(chunk) } : undefined);
    await claudeMetrics?.close().catch(() => undefined);
    await codexOtelMetrics?.close().catch(() => undefined);
    await grokOtelMetrics?.close().catch(() => undefined);
    if (database && runId) {
      try {
        database.finishRun(runId, code, new Date().toISOString());
        if (provider === "claude") {
          const measured = database.hasUsage(runId);
          database.markCollection(runId, measured ? "collected" : "unavailable", measured ? undefined : "otlp-missing");
        }
        if (provider === "codex") {
          // OTLP gives interactive and exec sessions category-level metrics.
          // Preserve the old `exec` total only when the receiver did not
          // deliver a correlated sample, never double-count both sources.
          const total = codexExecMetrics?.finish();
          if (!database.hasUsage(runId) && total !== undefined) {
            database.addUsage({ runId, observedAt: new Date().toISOString(), source: "codex-cli-reported-total-v1", reportedTotal: total });
          }
          // No ambient provider log can safely be correlated with this run.
          // Once Codex has exited and its session-scoped OTLP receiver is
          // closed, a missing sample is definitively unavailable. Finalizing
          // here also keeps Linux installations accurate without a macOS
          // LaunchAgent.
          const measured = database.hasUsage(runId);
          database.markCollection(runId, measured ? "collected" : "unavailable", measured ? undefined : codexOtelMetrics ? "otlp-missing" : "no-correlated-counters");
        }
        if (provider === "grok") {
          const usage = grokMetrics?.finish();
          // JSON single-turn remains a safe fallback for older CLIs or an
          // unavailable receiver, but it is never added on top of OTLP.
          if (!database.hasUsage(runId) && usage) {
            database.addUsage({ runId, observedAt: new Date().toISOString(), source: "grok-cli-json-usage-v1", ...usage });
          }
          const measured = database.hasUsage(runId);
          const reason = grokOtelMetrics ? "otlp-missing" : grokMetrics ? "no-correlated-counters" : "grok-tty";
          database.markCollection(runId, measured ? "collected" : "unavailable", measured ? undefined : reason);
        }
        if (provider === "kimi") {
          database.markCollection(runId, "unavailable", "kimi-envelope");
        }
      } catch {
        process.stderr.write("TokenPilot: telemetry completion unavailable.\n");
      }
    }
    return code ?? 1;
  } finally {
    await claudeMetrics?.close().catch(() => undefined);
    await codexOtelMetrics?.close().catch(() => undefined);
    await grokOtelMetrics?.close().catch(() => undefined);
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
