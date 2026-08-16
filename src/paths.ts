import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface TokenPilotPaths {
  userHome: string;
  home: string;
  configDir: string;
  dataDir: string;
  runtimeDir: string;
  shimDir: string;
  configFile: string;
  databaseFile: string;
  launchAgentFile: string;
}

export interface PathOptions {
  /** Test-only escape hatch. The installed CLI must never honor mutable state roots. */
  allowEnvironmentOverrides?: boolean;
  /** Test-only platform selector for validating platform-owned state paths. */
  platform?: NodeJS.Platform;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env, options: PathOptions = {}): TokenPilotPaths {
  // HOME and TOKENPILOT_* are process-controlled inputs. The production CLI
  // uses the OS-provided home directory so an AI-assisted install cannot
  // redirect persistent shims, shell files, or LaunchAgent state.
  const useOverrides = options.allowEnvironmentOverrides === true;
  // os.homedir() consults HOME on POSIX. userInfo().homedir comes from the
  // authenticated account record instead, so a hostile process environment
  // cannot redirect persistent installation state.
  const accountHome = os.userInfo().homedir;
  const userHome = useOverrides ? env.HOME ?? accountHome : accountHome;
  const home = useOverrides ? env.TOKENPILOT_HOME ?? path.join(userHome, ".tokenpilot") : path.join(userHome, ".tokenpilot");
  const platform = options.platform ?? process.platform;
  // Linux accounts commonly make ~/.config and ~/.local group-writable for
  // desktop tooling. TokenPilot must never weaken that protection or modify
  // those shared directories, so Linux state lives entirely below its own
  // 0700 home. macOS retains the existing per-user locations for compatibility.
  const defaultConfigDir = platform === "linux" ? path.join(home, "config") : path.join(userHome, ".config", "tokenpilot");
  const defaultDataDir = platform === "linux" ? path.join(home, "data") : path.join(userHome, ".local", "share", "tokenpilot");
  const configDir = useOverrides ? env.TOKENPILOT_CONFIG_HOME ?? defaultConfigDir : defaultConfigDir;
  const dataDir = useOverrides ? env.TOKENPILOT_DATA_HOME ?? defaultDataDir : defaultDataDir;
  const runtimeDir = path.join(home, "run");

  return {
    userHome,
    home,
    configDir,
    dataDir,
    runtimeDir,
    shimDir: path.join(home, "bin"),
    configFile: path.join(configDir, "config.json"),
    databaseFile: path.join(dataDir, "telemetry.sqlite"),
    launchAgentFile: path.join(userHome, "Library", "LaunchAgents", "com.tokenpilot.agent.plist")
  };
}

function currentUid(): number {
  return process.getuid?.() ?? os.userInfo().uid;
}

/** macOS ACLs can grant writes even when POSIX mode bits are restrictive. */
function hasMacAcl(target: string): boolean {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("/bin/ls", ["-lde", target], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return true;
  // Refuse every ACL entry rather than trying to infer named-principal write
  // access. Managed state must remain private to this account.
  return result.stdout.trim().split(/\r?\n/).length > 1;
}

function assertWithinUserHome(paths: TokenPilotPaths, target: string): string {
  const userHome = path.resolve(paths.userHome);
  const resolved = path.resolve(target);
  const relative = path.relative(userHome, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Refusing TokenPilot state outside the current user home");
  }
  return resolved;
}

function assertSafeDirectory(target: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== currentUid() || (stat.mode & 0o022) !== 0 || hasMacAcl(target)) {
    throw new Error(`Refusing unsafe TokenPilot directory: ${target}`);
  }
}

export function assertSafeUserHome(paths: TokenPilotPaths): void {
  assertSafeDirectory(path.resolve(paths.userHome));
}

/** Returns false for an absent directory and throws for an unsafe ancestor. */
export function hasSafePrivateDirectory(paths: TokenPilotPaths, directory: string): boolean {
  const userHome = path.resolve(paths.userHome);
  const target = assertWithinUserHome(paths, directory);
  assertSafeUserHome(paths);
  const relative = path.relative(userHome, target);
  let current = userHome;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      assertSafeDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

/**
 * Establishes a user-owned state directory one component at a time. This
 * deliberately rejects symlinks and group/world-writable ancestors rather
 * than following a pre-existing path outside the user's home.
 */
export function ensurePrivateDirectory(paths: TokenPilotPaths, directory: string): void {
  const userHome = path.resolve(paths.userHome);
  const target = assertWithinUserHome(paths, directory);
  assertSafeUserHome(paths);
  const relative = path.relative(userHome, target);
  let current = userHome;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      assertSafeDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      assertSafeDirectory(current);
    }
  }
  fs.chmodSync(target, 0o700);
  assertSafeDirectory(target);
}

/** Rejects a symlink, special file, or hard-linked file before it is read. */
export function assertSafeStateFile(paths: TokenPilotPaths, file: string): void {
  assertWithinUserHome(paths, file);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid() || hasMacAcl(file)) {
      throw new Error(`Refusing unsafe TokenPilot state file: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
