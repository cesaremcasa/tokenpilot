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

export type DoctorStatus = "ready" | "warning" | "unavailable";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ready: boolean;
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

function providerCapability(provider: Provider, binary: string): DoctorCheck {
  const adapter = getAdapter(provider);
  const plan = planForInstalledCli(provider, "balanced", binary, localHelpEnvironment());
  let telemetry: string;
  if (provider === "claude") telemetry = "metrics-only local OTLP; a session must publish numeric counters before it is measured";
  else if (provider === "codex") telemetry = plan.applied
    ? "metrics-only local OTLP for normal and exec sessions when the local CLI accepts session config"
    : "only the published total from codex exec is available on this local CLI";
  else if (provider === "grok") telemetry = "only one-turn JSON mode is measured; normal TTY sessions are unavailable for token comparison";
  else telemetry = "session envelope only; no token or savings measurement is declared";
  const optimization = plan.applied ? `balanced available (${plan.profile})` : `balanced not injected (${plan.unavailableReason ?? "local help probe did not confirm it"})`;
  return {
    name: `${provider} CLI`,
    status: plan.applied || provider === "grok" || provider === "kimi" ? "ready" : "warning",
    detail: `${telemetry}; ${optimization}. ${adapter.capabilities.notes}`,
    fix: plan.applied ? undefined : "Update the provider CLI, then run tokenpilot doctor again. TokenPilot will fail open until a documented flag is confirmed."
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
  const support = runtimeSupport(options.platform ?? process.platform, options.nodeVersion ?? process.versions.node);
  checks.push(support.supported
    ? { name: "Platform and Node", status: "ready", detail: `${process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform} with Node ${options.nodeVersion ?? process.versions.node}` }
    : { name: "Platform and Node", status: "unavailable", detail: support.reason ?? "unsupported runtime", fix: "Use macOS or Linux with Node 22.5 or later." });

  const shell = path.basename(process.env.SHELL ?? "");
  checks.push(["zsh", "bash"].includes(shell)
    ? { name: "Shell", status: "ready", detail: `${shell} can load the TokenPilot PATH block` }
    : { name: "Shell", status: "warning", detail: "shell startup integration is not detected", fix: "Add the TokenPilot shim directory to PATH manually, or use zsh or bash." });

  const wrappers = PROVIDERS.map((provider) => regularFile(path.join(paths.shimDir, provider)));
  const command = regularFile(path.join(paths.shimDir, "tokenpilot"));
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const shimActive = onPath(paths.shimDir, pathValue);
  const shadowed = PROVIDERS.filter((provider) => {
    const resolved = resolvedPathCommand(provider, pathValue);
    const shim = path.join(paths.shimDir, provider);
    try {
      return !resolved || fs.realpathSync(shim) !== resolved;
    } catch {
      return true;
    }
  });
  checks.push(wrappers.every(Boolean) && command && shimActive && shadowed.length === 0
    ? { name: "Wrappers and PATH", status: "ready", detail: "tokenpilot and each provider wrapper win PATH resolution" }
    : { name: "Wrappers and PATH", status: "warning", detail: shadowed.length > 0 ? `${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} shadowed or not resolvable through TokenPilot` : "one or more wrappers are missing or the shim directory is not active on PATH", fix: "Run tokenpilot install, then start a new terminal or run exec \"$SHELL\" -l." });

  let providerCount = 0;
  for (const provider of PROVIDERS) {
    const binary = findOriginalBinary(provider, paths, options.pathValue ?? process.env.PATH ?? "");
    if (!binary) {
      checks.push({ name: `${provider} CLI`, status: "unavailable", detail: "original provider CLI was not found outside TokenPilot wrappers", fix: `Install or expose ${provider} on PATH, then rerun tokenpilot install.` });
      continue;
    }
    providerCount += 1;
    checks.push(providerCapability(provider, binary));
  }

  const plan = createInstallPlan(paths);
  checks.push(...plan.skills.map(skillCheck));
  const required = checks.filter((check) => ["Platform and Node", "Wrappers and PATH"].includes(check.name));
  return { ready: support.supported && providerCount > 0 && required.every((check) => check.status === "ready"), checks };
}

export function doctorMarkdown(report: DoctorReport): string {
  const lines = ["# TokenPilot doctor", "", `Overall: ${report.ready ? "ready" : "needs attention"}`, "", "| Check | Status | Detail |", "| --- | --- | --- |"];
  for (const check of report.checks) lines.push(`| ${check.name} | ${check.status} | ${check.detail} |`);
  const fixes = report.checks.filter((check) => check.fix);
  if (fixes.length > 0) {
    lines.push("", "## Next steps", "");
    for (const check of fixes) lines.push(`- ${check.name}: ${check.fix}`);
  }
  lines.push("");
  return lines.join("\n");
}
