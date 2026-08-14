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

export function getPaths(env: NodeJS.ProcessEnv = process.env): TokenPilotPaths {
  const userHome = env.HOME ?? os.homedir();
  const home = env.TOKENPILOT_HOME ?? path.join(userHome, ".tokenpilot");
  const configDir = env.TOKENPILOT_CONFIG_HOME ?? path.join(userHome, ".config", "tokenpilot");
  const dataDir = env.TOKENPILOT_DATA_HOME ?? path.join(userHome, ".local", "share", "tokenpilot");
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
