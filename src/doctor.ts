import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAdapter } from "./adapters/index.js";
import { createInstallPlan, runtimeSupport, type SkillPlan } from "./installer.js";
import { findOriginalBinary } from "./launcher.js";
import { planForInstalledCli } from "./optimization.js";
import type { Provider } from "./types.js";
import { PROVIDERS } from "./types.js";
import type { TokenPilotPaths } from "./paths.js";

export type DoctorStatus = "ready" | "warning" | "active" | "shadowed" | "unavailable" | "limited";
export type ProviderDoctorState = "active" | "shadowed" | "unavailable" | "limited";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  /** Backward-compatible alias for installation readiness. */
  ready: boolean;
  installationReady: boolean;
  measurementReady: boolean;
  providers: Array<{ provider: Provider; state: ProviderDoctorState; detail: string; fix?: string }>;
  checks: DoctorCheck[];
}

function onPath(directory: string, value = process.env.PATH ?? ""): boolean {
  return value.split(path.delimiter).filter(Boolean).some((entry) => {
    try {
      return fs.realpathSync(entry) === fs.realpathSync(directory);
    } catch {
      return path.resolve(entry) === path.resolve(directory);
    }
  });
}

/** Resolve the command that a POSIX PATH lookup would actually execute. */
function resolvedPathCommand(command: string, value: string): string | undefined {
  for (const directory of value.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      return fs.realpathSync(candidate);
    } catch {
      // Continue to the next PATH entry; doctor is a non-mutating check.
    }
  }
  return undefined;
}

function regularFile(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function localHelpEnvironment(): NodeJS.ProcessEnv {
  // A `--help` probe does not need provider credentials, project state, or
  // TokenPilot flags. Keep it intentionally minimal and local.
  return { HOME: os.userInfo().homedir, PATH: process.env.PATH ?? "", NO_COLOR: "1" };
}

function providerCapability(provider: Provider, binary: string): { provider: Provider; state: ProviderDoctorState; detail: string; fix?: string } {
  const adapter = getAdapter(provider);
  const plan = planForInstalledCli(provider, "balanced", binary, localHelpEnvironment());
  let telemetry: string;
  if (provider === "claude") telemetry = "metrics-only local OTLP; a session must publish numeric counters before it is measured";
  else if (provider === "codex") telemetry = plan.applied
    ? "metrics-only local OTLP for normal and exec sessions when the local CLI accepts session config"
    : "only the published total from codex exec is available on this local CLI";
  else if (provider === "grok") telemetry = "only one-turn JSON mode is measured; the adapter does not measure TTY/TUI — no estimate";
  else telemetry = "session envelope only; no token or savings measurement is declared";
  const optimization = plan.applied ? `balanced available (${plan.profile})` : `balanced not injected (${plan.unavailableReason ?? "local help probe did not confirm it"})`;
  const state: ProviderDoctorState = provider === "grok" || provider === "kimi" || (provider === "codex" && !plan.applied) ? "limited" : "active";
  const intentionallyObserveOnly = provider === "claude" && plan.unavailableReason?.includes("observe-only");
  return {
    provider,
    state,
    detail: `${telemetry}; ${optimization}. ${adapter.capabilities.notes}`,
    fix: plan.applied || intentionallyObserveOnly ? undefined : "Update the provider CLI, then run tokenpilot doctor again. TokenPilot will fail open until a documented flag is confirmed."
  };
}

function skillCheck(skill: SkillPlan): DoctorCheck {
  const destination = skill.target.includes(`${path.sep}.agents${path.sep}`) ? "Codex skill" : skill.target.includes(`${path.sep}.claude${path.sep}`) ? "Claude skill" : "Kimi skill";
  if (skill.state === "skipped") {
    return { name: destination, status: "warning", detail: `optional skill ignored: ${skill.reason ?? "local safety check"}`, fix: "Keep the directory private and non-symlinked, or install the skill separately. Provider wrappers remain available." };
  }
  const state = skill.state === "installed" ? "installed" : skill.state === "update" ? "installed and can be refreshed" : "available to install";
  return { name: destination, status: "ready", detail: `optional ${state}` };
}

/** Non-mutating local readiness check; it never opens SQLite or creates config. */
export function doctor(paths: TokenPilotPaths, options: { platform?: string; nodeVersion?: string; pathValue?: string } = {}): DoctorReport {
  const checks: DoctorCheck[] = [];
  const providers: DoctorReport["providers"] = [];
  const platform = options.platform ?? process.platform;
  const support = runtimeSupport(platform, options.nodeVersion ?? process.versions.node);
  checks.push(support.supported
    ? { name: "Platform and Node", status: "ready", detail: `${platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform} with Node ${options.nodeVersion ?? process.versions.node}` }
    : { name: "Platform and Node", status: "unavailable", detail: support.reason ?? "unsupported runtime", fix: "Use macOS or Linux with Node 22.5 or later." });

  const shell = path.basename(process.env.SHELL ?? "");
  checks.push(["zsh", "bash"].includes(shell)
    ? { name: "Shell", status: "ready", detail: `${shell} can load the TokenPilot PATH block` }
    : { name: "Shell", status: "warning", detail: "shell startup integration is not detected", fix: "Add the TokenPilot shim directory to PATH manually, or use zsh or bash." });

  const wrappers = PROVIDERS.map((provider) => regularFile(path.join(paths.shimDir, provider)));
  const command = regularFile(path.join(paths.shimDir, "tokenpilot"));
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const shimActive = onPath(paths.shimDir, pathValue);
  let commandActive = false;
  try {
    commandActive = command && resolvedPathCommand("tokenpilot", pathValue) === fs.realpathSync(path.join(paths.shimDir, "tokenpilot"));
  } catch {
    commandActive = false;
  }
  checks.push(wrappers.every(Boolean) && commandActive && shimActive
    ? { name: "Wrappers and PATH", status: "ready", detail: "tokenpilot and provider wrappers are installed and the shim directory is on PATH" }
    : { name: "Wrappers and PATH", status: "warning", detail: "one or more wrappers are missing or the shim directory is not active on PATH", fix: "Run tokenpilot install, then start a new terminal or run exec \"$SHELL\" -l." });

  let providerCount = 0;
  for (const provider of PROVIDERS) {
    const binary = findOriginalBinary(provider, paths, options.pathValue ?? process.env.PATH ?? "");
    if (!binary) {
      const result = { provider, state: "unavailable" as const, detail: "original provider CLI was not found outside TokenPilot wrappers", fix: `Install or expose ${provider} on PATH, then rerun tokenpilot install.` };
      providers.push(result);
      checks.push({ name: `${provider} CLI`, status: result.state, detail: result.detail, fix: result.fix });
      continue;
    }
    providerCount += 1;
    const resolved = resolvedPathCommand(provider, pathValue);
    const shim = path.join(paths.shimDir, provider);
    let shimWins = false;
    try {
      shimWins = Boolean(resolved && fs.realpathSync(shim) === resolved);
    } catch {
      shimWins = false;
    }
    const result = shimWins
      ? providerCapability(provider, binary)
      : { provider, state: "shadowed" as const, detail: "an external provider binary wins PATH resolution before the TokenPilot shim", fix: "Put the TokenPilot shim directory first on PATH, then start a new terminal." };
    providers.push(result);
    checks.push({ name: `${provider} CLI`, status: result.state, detail: result.detail, fix: result.fix });
  }

  const plan = createInstallPlan(paths);
  checks.push(...plan.skills.map(skillCheck));
  const required = checks.filter((check) => ["Platform and Node", "Wrappers and PATH"].includes(check.name));
  const installationReady = support.supported && providerCount > 0 && required.every((check) => check.status === "ready") && !providers.some((provider) => provider.state === "shadowed");
  const installedProviders = providers.filter((provider) => provider.state !== "unavailable");
  const measurementReady = installationReady && installedProviders.length > 0 && installedProviders.every((provider) => provider.state === "active");
  return { ready: installationReady, installationReady, measurementReady, providers, checks };
}

export function doctorMarkdown(report: DoctorReport): string {
  const lines = ["# TokenPilot doctor", "", `Installation: ${report.installationReady ? "ready" : "needs attention"}`, `Measurement: ${report.measurementReady ? "ready" : "limited"}`, "", "Installation readiness and measurement capability are independent. A working launcher does not make every provider modality measurable.", "", "| Check | Status | Detail |", "| --- | --- | --- |"];
  for (const check of report.checks) lines.push(`| ${check.name} | ${check.status} | ${check.detail} |`);
  const fixes = report.checks.filter((check) => check.fix);
  if (fixes.length > 0) {
    lines.push("", "## Next steps", "");
    for (const check of fixes) lines.push(`- ${check.name}: ${check.fix}`);
  }
  lines.push("");
  return lines.join("\n");
}
