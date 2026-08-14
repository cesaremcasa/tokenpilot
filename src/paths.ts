import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const configDir = useOverrides ? env.TOKENPILOT_CONFIG_HOME ?? path.join(userHome, ".config", "tokenpilot") : path.join(userHome, ".config", "tokenpilot");
  const dataDir = useOverrides ? env.TOKENPILOT_DATA_HOME ?? path.join(userHome, ".local", "share", "tokenpilot") : path.join(userHome, ".local", "share", "tokenpilot");
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
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== currentUid() || (stat.mode & 0o022) !== 0) {
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
}

/** Rejects a symlink, special file, or hard-linked file before it is read. */
export function assertSafeStateFile(paths: TokenPilotPaths, file: string): void {
  assertWithinUserHome(paths, file);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid()) {
      throw new Error(`Refusing unsafe TokenPilot state file: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
