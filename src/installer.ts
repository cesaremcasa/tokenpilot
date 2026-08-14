import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureConfig } from "./config.js";
import type { TokenPilotPaths } from "./paths.js";
import { PROVIDERS } from "./types.js";

const SHELL_MARKER_START = "# >>> tokenpilot >>>";
const SHELL_MARKER_END = "# <<< tokenpilot <<<";
const LAUNCH_AGENT_LABEL = "com.tokenpilot.agent";

export interface InstallOptions {
  dryRun?: boolean;
  noShellConfig?: boolean;
  noAgent?: boolean;
  executable?: string;
  nodeExecutable?: string;
  shell?: string;
}

export interface InstallPlan {
  shims: string[];
  shellFile?: string;
  launchAgent?: string;
}

function shellStartupFile(shell: string | undefined, home = os.homedir()): string | undefined {
  const name = path.basename(shell ?? "");
  if (name === "zsh") return path.join(home, ".zshrc");
  if (name === "bash") return path.join(home, ".bashrc");
  return undefined;
}

function shellBlock(shimDir: string): string {
  return `${SHELL_MARKER_START}\nexport PATH="${shimDir}:$PATH"\n${SHELL_MARKER_END}\n`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createInstallPlan(paths: TokenPilotPaths, options: InstallOptions = {}): InstallPlan {
  const shellFile = options.noShellConfig ? undefined : shellStartupFile(options.shell ?? process.env.SHELL, paths.userHome);
  return {
    shims: PROVIDERS.map((provider) => path.join(paths.shimDir, provider)),
    shellFile,
    launchAgent: options.noAgent ? undefined : paths.launchAgentFile
  };
}

function writeShim(target: string, provider: string, nodeExecutable: string, executable: string): void {
  const contents = `#!/bin/sh\nexport TOKENPILOT_SHIM_DIR=${quoteShell(path.dirname(target))}\nexec ${quoteShell(nodeExecutable)} ${quoteShell(executable)} __shim ${provider} "$@"\n`;
  fs.writeFileSync(target, contents, { mode: 0o700 });
}

function appendShellBlock(file: string, block: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(SHELL_MARKER_START)) return;
  fs.appendFileSync(file, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${block}`, { mode: 0o600 });
}

function launchAgentPlist(nodeExecutable: string, executable: string, paths: TokenPilotPaths): string {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string><string>${xml(executable)}</string><string>agent</string><string>--interval</string><string>60</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(paths.runtimeDir, "agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(paths.runtimeDir, "agent.error.log"))}</string>
</dict></plist>
`;
}

function bootstrapAgent(plist: string): void {
  const domain = `gui/${process.getuid?.() ?? process.env.UID ?? ""}`;
  spawnSync("launchctl", ["bootout", domain, LAUNCH_AGENT_LABEL], { stdio: "ignore" });
  const result = spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("launchctl could not start the TokenPilot agent");
}

export function install(paths: TokenPilotPaths, options: InstallOptions = {}): InstallPlan {
  const plan = createInstallPlan(paths, options);
  if (options.dryRun) return plan;

  const executable = options.executable ?? fileURLToPath(import.meta.url).replace(/installer\.js$/, "cli.js");
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  fs.mkdirSync(paths.shimDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  ensureConfig(paths);

  for (const provider of PROVIDERS) writeShim(path.join(paths.shimDir, provider), provider, nodeExecutable, executable);
  if (plan.shellFile) appendShellBlock(plan.shellFile, shellBlock(paths.shimDir));
  if (plan.launchAgent) {
    fs.mkdirSync(path.dirname(plan.launchAgent), { recursive: true, mode: 0o700 });
    fs.writeFileSync(plan.launchAgent, launchAgentPlist(nodeExecutable, executable, paths), { mode: 0o600 });
    if (process.platform === "darwin") bootstrapAgent(plan.launchAgent);
  }
  return plan;
}

export function uninstall(paths: TokenPilotPaths, dryRun = false): InstallPlan {
  const plan = createInstallPlan(paths);
  if (dryRun) return plan;
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? process.env.UID ?? ""}`;
    spawnSync("launchctl", ["bootout", domain, LAUNCH_AGENT_LABEL], { stdio: "ignore" });
  }
  for (const shim of plan.shims) fs.rmSync(shim, { force: true });
  if (plan.launchAgent) fs.rmSync(plan.launchAgent, { force: true });
  if (plan.shellFile && fs.existsSync(plan.shellFile)) {
    const source = fs.readFileSync(plan.shellFile, "utf8");
    const expression = new RegExp(`\\n?${SHELL_MARKER_START.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\n[\\s\\S]*?${SHELL_MARKER_END.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\n?`, "g");
    fs.writeFileSync(plan.shellFile, source.replace(expression, ""), { mode: 0o600 });
  }
  return plan;
}
