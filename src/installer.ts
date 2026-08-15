import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ensureConfig } from "./config.js";
import { assertSafeUserHome, ensurePrivateDirectory, hasSafePrivateDirectory, type TokenPilotPaths } from "./paths.js";
import { PROVIDERS, type Provider } from "./types.js";

const SHELL_MARKER_START = "# >>> tokenpilot >>>";
const SHELL_MARKER_END = "# <<< tokenpilot <<<";
const LAUNCH_AGENT_LABEL = "com.tokenpilot.agent";
const LAUNCH_AGENT_MARKER = "<key>TokenPilotManaged</key><true/>";
const LAUNCHCTL = "/bin/launchctl";
const SKILL_MARKER = "tokenpilot-managed-skill";
const SKILL_RELATIVE_PATH = path.join("tokenpilot", "SKILL.md");
const SKILL_COMMAND_PLACEHOLDER = "{{TOKENPILOT_COMMAND}}";
const COMMAND_MARKER = "# tokenpilot-command-shim";
const RUNTIME_RELEASES_DIRECTORY = "releases";
const SKILL_HOST_DIRECTORY: Record<Provider, string> = {
  claude: ".claude",
  codex: ".agents",
  grok: ".grok",
  kimi: ".kimi"
};
const SKILL_HOSTS: Provider[] = ["codex", "claude", "grok", "kimi"];

export interface InstallOptions {
  dryRun?: boolean;
  noShellConfig?: boolean;
  noAgent?: boolean;
  noSkills?: boolean;
  executable?: string;
  nodeExecutable?: string;
  shell?: string;
}

export interface InstallPlan {
  shims: string[];
  command: string;
  skills: SkillPlan[];
  /** All startup files that receive the exact managed PATH block. */
  shellFiles?: string[];
  /** Backwards-compatible primary interactive startup file. */
  shellFile?: string;
  launchAgent?: string;
}

export interface SkillPlan {
  provider: Provider;
  target: string;
  /** `skipped` is safe and does not prevent the core launcher install. */
  state: "install" | "update" | "installed" | "skipped";
  reason?: string;
}

export interface RuntimeSupport {
  supported: boolean;
  reason?: string;
}

/** Pure preflight used by install and doctor; it never writes local state. */
export function runtimeSupport(platform: string = process.platform, nodeVersion = process.versions.node): RuntimeSupport {
  if (platform !== "darwin" && platform !== "linux") {
    return { supported: false, reason: `Unsupported platform: ${platform}. TokenPilot supports macOS and Linux only.` };
  }
  const match = /^(\d+)\.(\d+)/.exec(nodeVersion);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (major < 22 || (major === 22 && minor < 5)) {
    return { supported: false, reason: `Node ${nodeVersion} is unsupported. Install Node 22.5 or later and run tokenpilot install again.` };
  }
  return { supported: true };
}

export function assertRuntimeSupported(platform: string = process.platform, nodeVersion = process.versions.node): void {
  const support = runtimeSupport(platform, nodeVersion);
  if (!support.supported) throw new Error(support.reason);
}

/**
 * The background collector is a macOS LaunchAgent. Linux sessions finalize
 * their own collection state, so an install there must not write an inert
 * plist under a Linux home directory.
 */
export function shouldInstallLaunchAgent(platform = process.platform, noAgent = false): boolean {
  return platform === "darwin" && !noAgent;
}

function shellStartupFiles(shell: string | undefined, home = os.homedir()): string[] {
  const name = path.basename(shell ?? "");
  if (name === "zsh") return [path.join(home, ".zshrc")];
  if (name !== "bash") return [];

  // Bash uses .bashrc for interactive non-login shells, while a login shell
  // reads the first existing file among .bash_profile, .bash_login, and
  // .profile. Install in .bashrc plus every existing login candidate so a
  // later PATH assignment in an explicitly sourced profile cannot shadow a
  // shim. Do not create a higher-precedence login file: doing so would alter
  // Bash's normal startup-file selection.
  const files = [path.join(home, ".bashrc")];
  const loginCandidates = [".bash_profile", ".bash_login", ".profile"]
    .map((file) => path.join(home, file))
    .filter((file) => fs.existsSync(file));
  return [...files, ...(loginCandidates.length > 0 ? loginCandidates : [path.join(home, ".profile")])];
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

function hasOwnedCommand(contents: string): boolean {
  return contents.includes(COMMAND_MARKER);
}

function assertShimTarget(target: string, provider: string): void {
  assertSafeText(target, "shim path");
  if (existingRegularFile(target) && !hasOwnedShim(fs.readFileSync(target, "utf8"), provider)) {
    throw new Error(`Refusing to overwrite non-TokenPilot shim: ${target}`);
  }
}

function assertCommandTarget(target: string): void {
  assertSafeText(target, "command shim path");
  if (existingRegularFile(target) && !hasOwnedCommand(fs.readFileSync(target, "utf8"))) {
    throw new Error(`Refusing to overwrite non-TokenPilot command shim: ${target}`);
  }
}

function assertShellStartupFile(target: string): void {
  if (fs.existsSync(target)) existingRegularFile(target);
}

function assertLaunchAgentTarget(target: string): void {
  if (existingRegularFile(target) && !hasOwnedLaunchAgent(fs.readFileSync(target, "utf8"))) {
    throw new Error(`Refusing to overwrite non-TokenPilot LaunchAgent: ${target}`);
  }
}

function hasOwnedLaunchAgent(contents: string): boolean {
  return contents.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`) && contents.includes(LAUNCH_AGENT_MARKER);
}

function hasOwnedSkill(contents: string): boolean {
  return contents.includes(SKILL_MARKER);
}

function sourceSkillFile(provider: Provider): string {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", SKILL_HOST_DIRECTORY[provider], "skills", SKILL_RELATIVE_PATH);
  if (!existingRegularFile(source)) {
    throw new Error("TokenPilot skill source is missing or invalid");
  }
  const contents = fs.readFileSync(source, "utf8");
  if (!hasOwnedSkill(contents) || !contents.includes(SKILL_COMMAND_PLACEHOLDER)) {
    throw new Error("TokenPilot skill source is missing or invalid");
  }
  return source;
}

/**
 * Skills are optional integrations. A bad or third-party skill target is a
 * local warning, never a reason to withhold the core provider wrappers.
 */
export function assessSkillTarget(paths: TokenPilotPaths, target: string, provider: Provider = "codex"): SkillPlan {
  const directory = path.dirname(target);
  try {
    // This also validates every existing ancestor while permitting a missing
    // final TokenPilot-owned directory to be created with 0700 permissions.
    hasSafePrivateDirectory(paths, directory);
  } catch {
    return { provider, target, state: "skipped", reason: "skill directory is unsafe or symlinked" };
  }
  try {
    if (!fs.existsSync(target)) return { provider, target, state: "install" };
    if (!existingRegularFile(target)) return { provider, target, state: "skipped", reason: "skill target is not a private regular file" };
    if (!hasOwnedSkill(fs.readFileSync(target, "utf8"))) {
      return { provider, target, state: "skipped", reason: "a third-party skill already owns this target" };
    }
    return { provider, target, state: "update" };
  } catch {
    return { provider, target, state: "skipped", reason: "skill target could not be safely inspected" };
  }
}

function writeSkills(paths: TokenPilotPaths, skills: SkillPlan[], command: string): void {
  const candidates = skills.filter((skill) => skill.state === "install" || skill.state === "update");
  if (candidates.length === 0) return;
  assertSafeText(command, "skill command path");
  for (const skill of candidates) {
    try {
      const contents = fs.readFileSync(sourceSkillFile(skill.provider), "utf8").replaceAll(SKILL_COMMAND_PLACEHOLDER, quoteShell(command));
      // Reassess immediately before writing so a concurrent replacement can
      // only disable this optional integration, never redirect the write.
      const latest = assessSkillTarget(paths, skill.target, skill.provider);
      if (latest.state === "skipped") {
        skill.state = "skipped";
        skill.reason = latest.reason;
        continue;
      }
      ensurePrivateDirectory(paths, path.dirname(skill.target));
      fs.writeFileSync(skill.target, contents, { mode: 0o600 });
      skill.state = "installed";
      delete skill.reason;
    } catch (error) {
      skill.state = "skipped";
      skill.reason = error instanceof Error && error.message.includes("skill source")
        ? `packaged ${skill.provider} TokenPilot skill is unavailable`
        : "skill write was refused by local safety checks";
    }
  }
}

/**
 * A launcher must not keep executing a file inside the cloned checkout. Apart
 * from breaking when that checkout is moved, macOS can deny a later read of a
 * file that was created by another application or restored from quarantine.
 * We therefore copy the small, dependency-free compiled bundle into TokenPilot
 * private state during installation and point every managed entry point there.
 */
function runtimeBundleSource(executable: string): string | undefined {
  const normalized = path.resolve(executable);
  const dist = path.dirname(normalized);
  const root = path.dirname(dist);
  if (path.basename(dist) !== "dist" || path.basename(normalized) !== "cli.js") return undefined;
  const skill = path.join(root, ".agents", "skills", SKILL_RELATIVE_PATH);
  try {
    if (!existingRegularFile(normalized) || !existingRegularFile(skill)) return undefined;
    return root;
  } catch {
    return undefined;
  }
}

function copyPrivateTree(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Invalid TokenPilot runtime source: ${source}`);
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    const childSource = path.join(source, name);
    const childDestination = path.join(destination, name);
    const child = fs.lstatSync(childSource);
    if (child.isSymbolicLink()) throw new Error(`Invalid TokenPilot runtime source: ${childSource}`);
    if (child.isDirectory()) {
      copyPrivateTree(childSource, childDestination);
    } else if (child.isFile() && child.nlink === 1) {
      // Reading then writing creates a fresh, private file rather than
      // preserving an ACL, extended attribute, or filesystem clone from the
      // development checkout.
      fs.writeFileSync(childDestination, fs.readFileSync(childSource), { mode: 0o600 });
    } else {
      throw new Error(`Invalid TokenPilot runtime source: ${childSource}`);
    }
  }
}

function stageRuntimeBundle(paths: TokenPilotPaths, executable: string): string {
  const source = runtimeBundleSource(executable);
  if (!source) return executable;
  const releases = path.join(paths.runtimeDir, RUNTIME_RELEASES_DIRECTORY);
  ensurePrivateDirectory(paths, releases);
  const release = path.join(releases, randomUUID());
  try {
    fs.mkdirSync(release, { mode: 0o700 });
    copyPrivateTree(path.join(source, "dist"), path.join(release, "dist"));
    for (const directory of new Set(Object.values(SKILL_HOST_DIRECTORY))) {
      const skillSource = path.join(source, directory);
      if (fs.existsSync(skillSource)) copyPrivateTree(skillSource, path.join(release, directory));
    }
    const stagedCli = path.join(release, "dist", "cli.js");
    if (!existingRegularFile(stagedCli)) throw new Error("TokenPilot runtime bundle is incomplete");
    return stagedCli;
  } catch (error) {
    // This directory was freshly created with an unpredictable name in a
    // private TokenPilot-owned parent, so it is safe to clean up on failure.
    fs.rmSync(release, { recursive: true, force: true });
    throw error;
  }
}

export function createInstallPlan(paths: TokenPilotPaths, options: InstallOptions = {}): InstallPlan {
  const shellFiles = options.noShellConfig ? [] : shellStartupFiles(options.shell ?? process.env.SHELL, paths.userHome);
  const skillTargets = options.noSkills ? [] : SKILL_HOSTS.map((provider) => ({
    provider,
    target: path.join(paths.userHome, SKILL_HOST_DIRECTORY[provider], "skills", SKILL_RELATIVE_PATH)
  }));
  return {
    shims: PROVIDERS.map((provider) => path.join(paths.shimDir, provider)),
    command: path.join(paths.shimDir, "tokenpilot"),
    skills: skillTargets.map(({ provider, target }) => assessSkillTarget(paths, target, provider)),
    shellFiles: shellFiles.length > 0 ? shellFiles : undefined,
    shellFile: shellFiles[0],
    launchAgent: shouldInstallLaunchAgent(process.platform, options.noAgent === true) ? paths.launchAgentFile : undefined
  };
}

function writeShim(target: string, provider: string, nodeExecutable: string, executable: string): void {
  assertShimTarget(target, provider);
  const contents = `#!/bin/sh\n# tokenpilot-shim\nNODE_NO_WARNINGS=1\nexport NODE_NO_WARNINGS\nexec ${quoteShell(nodeExecutable)} ${quoteShell(executable)} __shim ${provider} "$@"\n`;
  fs.writeFileSync(target, contents, { mode: 0o700 });
}

function writeCommandShim(target: string, nodeExecutable: string, executable: string): void {
  assertCommandTarget(target);
  const contents = `#!/bin/sh\n${COMMAND_MARKER}\nNODE_NO_WARNINGS=1\nexport NODE_NO_WARNINGS\nexec ${quoteShell(nodeExecutable)} ${quoteShell(executable)} "$@"\n`;
  fs.writeFileSync(target, contents, { mode: 0o700 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The managed block must be last: user startup files often append an npm or
 * ~/.local/bin PATH later. Only an exact block owned by this version may be
 * moved. Modified markers are treated as user content and never overwritten.
 */
function replaceShellBlock(file: string, block: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (existingRegularFile(file) === false && fs.existsSync(file)) throw new Error(`Refusing non-regular shell startup file: ${file}`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const exact = new RegExp(`${escapeRegExp(SHELL_MARKER_START)}\n${escapeRegExp(block.split("\n")[1])}\n${escapeRegExp(SHELL_MARKER_END)}\n?`, "g");
  const ownedBlocks = existing.match(exact) ?? [];
  if (existing.includes(SHELL_MARKER_START) || existing.includes(SHELL_MARKER_END)) {
    const markerPairs = (existing.match(new RegExp(escapeRegExp(SHELL_MARKER_START), "g")) ?? []).length
      + (existing.match(new RegExp(escapeRegExp(SHELL_MARKER_END), "g")) ?? []).length;
    if (markerPairs !== ownedBlocks.length * 2) {
      throw new Error("Refusing to modify a changed TokenPilot shell PATH block");
    }
  }
  const withoutOwnedBlock = existing.replace(exact, "").replace(/\n+$/, "");
  fs.writeFileSync(file, `${withoutOwnedBlock}${withoutOwnedBlock.length > 0 ? "\n" : ""}${block}`, { mode: 0o600 });
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

export function launchAgentServiceTarget(domain: string): string {
  return `${domain}/${LAUNCH_AGENT_LABEL}`;
}

function waitForAgentShutdown(milliseconds: number): void {
  // `launchctl bootout` returns before the service has necessarily left its
  // domain. A short bounded wait avoids a false install failure on an
  // immediate reinstall, without using `bootout --wait` (which can block
  // indefinitely when another program misbehaves).
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function bootstrapAgent(plist: string): void {
  const domain = `gui/${process.getuid?.() ?? process.env.UID ?? ""}`;
  // `bootout` accepts either a domain plus a plist path, or one complete
  // service target. Passing the label as a separate argument makes it look
  // like a plist path, leaves an existing agent running, and causes the
  // following bootstrap to fail on a repeat install.
  const serviceTarget = launchAgentServiceTarget(domain);
  spawnSync(LAUNCHCTL, ["bootout", serviceTarget], { stdio: "ignore" });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = spawnSync(LAUNCHCTL, ["bootstrap", domain, plist], { stdio: "ignore" });
    if (result.status === 0) return;
    waitForAgentShutdown(100);
  }
  throw new Error("launchctl could not start the TokenPilot agent");
}

export function install(paths: TokenPilotPaths, options: InstallOptions = {}): InstallPlan {
  assertRuntimeSupported();
  const plan = createInstallPlan(paths, options);
  if (options.dryRun) return plan;

  const executable = options.executable ?? fileURLToPath(import.meta.url).replace(/installer\.js$/, "cli.js");
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  // Validate all required user-owned targets before creating TokenPilot state.
  // Optional skills are assessed independently and can be safely skipped.
  for (const provider of PROVIDERS) assertShimTarget(path.join(paths.shimDir, provider), provider);
  assertCommandTarget(plan.command);
  for (const shellFile of plan.shellFiles ?? []) assertShellStartupFile(shellFile);
  if (plan.launchAgent) assertLaunchAgentTarget(plan.launchAgent);

  ensurePrivateDirectory(paths, paths.shimDir);
  ensurePrivateDirectory(paths, paths.runtimeDir);
  ensureConfig(paths);
  const installedExecutable = stageRuntimeBundle(paths, executable);
  for (const provider of PROVIDERS) writeShim(path.join(paths.shimDir, provider), provider, nodeExecutable, installedExecutable);
  writeCommandShim(plan.command, nodeExecutable, installedExecutable);
  writeSkills(paths, plan.skills, plan.command);
  for (const shellFile of plan.shellFiles ?? []) replaceShellBlock(shellFile, shellBlock(paths.shimDir));
  if (plan.launchAgent) {
    ensurePrivateDirectory(paths, path.dirname(plan.launchAgent));
    assertLaunchAgentTarget(plan.launchAgent);
    fs.writeFileSync(plan.launchAgent, launchAgentPlist(nodeExecutable, installedExecutable), { mode: 0o600 });
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
    spawnSync(LAUNCHCTL, ["bootout", launchAgentServiceTarget(domain)], { stdio: "ignore" });
  }
  if (hasSafePrivateDirectory(paths, paths.shimDir)) {
    for (const shim of plan.shims) {
      if (existingRegularFile(shim) && hasOwnedShim(fs.readFileSync(shim, "utf8"), path.basename(shim))) fs.rmSync(shim);
    }
    if (existingRegularFile(plan.command) && hasOwnedCommand(fs.readFileSync(plan.command, "utf8"))) fs.rmSync(plan.command);
  }
  for (const skill of plan.skills) {
    const skillDirectory = path.dirname(skill.target);
    try {
      if (!hasSafePrivateDirectory(paths, skillDirectory) || !existingRegularFile(skill.target)) continue;
      if (!hasOwnedSkill(fs.readFileSync(skill.target, "utf8"))) continue;
      fs.rmSync(skill.target);
      try {
        fs.rmdirSync(skillDirectory);
      } catch {
        // Keep a directory containing user-owned supporting files.
      }
    } catch {
      // Optional unsafe integrations are never modified during uninstall.
    }
  }
  if (plan.launchAgent && ownsLaunchAgent) fs.rmSync(plan.launchAgent);
  const block = shellBlock(paths.shimDir);
  const expression = new RegExp(`${escapeRegExp(SHELL_MARKER_START)}\n${escapeRegExp(block.split("\n")[1])}\n${escapeRegExp(SHELL_MARKER_END)}\n?`, "g");
  for (const shellFile of [".zshrc", ".bashrc", ".bash_profile", ".bash_login", ".profile"].map((file) => path.join(paths.userHome, file))) {
    if (!fs.existsSync(shellFile) || !existingRegularFile(shellFile)) continue;
    const source = fs.readFileSync(shellFile, "utf8");
    fs.writeFileSync(shellFile, source.replace(expression, ""), { mode: 0o600 });
  }
  return plan;
}
