import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureConfig } from "./config.js";
import { assertSafeUserHome, ensurePrivateDirectory, hasSafePrivateDirectory, type TokenPilotPaths } from "./paths.js";
import { PROVIDERS } from "./types.js";

const SHELL_MARKER_START = "# >>> tokenpilot >>>";
const SHELL_MARKER_END = "# <<< tokenpilot <<<";
const LAUNCH_AGENT_LABEL = "com.tokenpilot.agent";
const LAUNCH_AGENT_MARKER = "<key>TokenPilotManaged</key><true/>";
const LAUNCHCTL = "/bin/launchctl";

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
  return `${SHELL_MARKER_START}\nexport PATH=${quoteShell(shimDir)}:"$PATH"\n${SHELL_MARKER_END}\n`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertSafeText(value: string, label: string): void {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw new Error(`Unsafe ${label}`);
}

function existingRegularFile(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(`Refusing non-regular TokenPilot target: ${target}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hasOwnedShim(contents: string, provider: string): boolean {
  return contents.includes("# tokenpilot-shim")
    || (contents.includes("TOKENPILOT_SHIM_DIR=") && contents.includes(`__shim ${provider}`));
}

function hasOwnedLaunchAgent(contents: string): boolean {
  return contents.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`) && contents.includes(LAUNCH_AGENT_MARKER);
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
  assertSafeText(target, "shim path");
  if (existingRegularFile(target) && !hasOwnedShim(fs.readFileSync(target, "utf8"), provider)) {
    throw new Error(`Refusing to overwrite non-TokenPilot shim: ${target}`);
  }
  const contents = `#!/bin/sh\n# tokenpilot-shim\nexec ${quoteShell(nodeExecutable)} ${quoteShell(executable)} __shim ${provider} "$@"\n`;
  fs.writeFileSync(target, contents, { mode: 0o700 });
}

function appendShellBlock(file: string, block: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (existingRegularFile(file) === false && fs.existsSync(file)) throw new Error(`Refusing non-regular shell startup file: ${file}`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(SHELL_MARKER_START)) return;
  fs.appendFileSync(file, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${block}`, { mode: 0o600 });
}

function launchAgentPlist(nodeExecutable: string, executable: string): string {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  ${LAUNCH_AGENT_MARKER}
  <key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string><string>${xml(executable)}</string><string>agent</string><string>--interval</string><string>60</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

function bootstrapAgent(plist: string): void {
  const domain = `gui/${process.getuid?.() ?? process.env.UID ?? ""}`;
  spawnSync(LAUNCHCTL, ["bootout", domain, LAUNCH_AGENT_LABEL], { stdio: "ignore" });
  const result = spawnSync(LAUNCHCTL, ["bootstrap", domain, plist], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("launchctl could not start the TokenPilot agent");
}

export function install(paths: TokenPilotPaths, options: InstallOptions = {}): InstallPlan {
  const plan = createInstallPlan(paths, options);
  if (options.dryRun) return plan;

  const executable = options.executable ?? fileURLToPath(import.meta.url).replace(/installer\.js$/, "cli.js");
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  ensurePrivateDirectory(paths, paths.shimDir);
  ensurePrivateDirectory(paths, paths.runtimeDir);
  ensureConfig(paths);

  for (const provider of PROVIDERS) writeShim(path.join(paths.shimDir, provider), provider, nodeExecutable, executable);
  if (plan.shellFile) appendShellBlock(plan.shellFile, shellBlock(paths.shimDir));
  if (plan.launchAgent) {
    ensurePrivateDirectory(paths, path.dirname(plan.launchAgent));
    if (existingRegularFile(plan.launchAgent) && !hasOwnedLaunchAgent(fs.readFileSync(plan.launchAgent, "utf8"))) {
      throw new Error(`Refusing to overwrite non-TokenPilot LaunchAgent: ${plan.launchAgent}`);
    }
    fs.writeFileSync(plan.launchAgent, launchAgentPlist(nodeExecutable, executable), { mode: 0o600 });
    if (process.platform === "darwin") bootstrapAgent(plan.launchAgent);
  }
  return plan;
}

export function uninstall(paths: TokenPilotPaths, dryRun = false): InstallPlan {
  const plan = createInstallPlan(paths);
  if (dryRun) return plan;
  assertSafeUserHome(paths);
  const ownsLaunchAgent = Boolean(plan.launchAgent
    && hasSafePrivateDirectory(paths, path.dirname(plan.launchAgent))
    && existingRegularFile(plan.launchAgent)
    && hasOwnedLaunchAgent(fs.readFileSync(plan.launchAgent, "utf8")));
  if (process.platform === "darwin" && ownsLaunchAgent) {
    const domain = `gui/${process.getuid?.() ?? process.env.UID ?? ""}`;
    spawnSync(LAUNCHCTL, ["bootout", domain, LAUNCH_AGENT_LABEL], { stdio: "ignore" });
  }
  if (hasSafePrivateDirectory(paths, paths.shimDir)) {
    for (const shim of plan.shims) {
      if (existingRegularFile(shim) && hasOwnedShim(fs.readFileSync(shim, "utf8"), path.basename(shim))) fs.rmSync(shim);
    }
  }
  if (plan.launchAgent && ownsLaunchAgent) fs.rmSync(plan.launchAgent);
  for (const shellFile of [path.join(paths.userHome, ".zshrc"), path.join(paths.userHome, ".bashrc")]) {
    if (!fs.existsSync(shellFile) || !existingRegularFile(shellFile)) continue;
    const source = fs.readFileSync(shellFile, "utf8");
    const expression = new RegExp(`\\n?${SHELL_MARKER_START.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\n[\\s\\S]*?${SHELL_MARKER_END.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\n?`, "g");
    fs.writeFileSync(shellFile, source.replace(expression, ""), { mode: 0o600 });
  }
  return plan;
}
