import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunMode, TokenPilotConfig } from "./types.js";
import { assertSafeStateFile, ensurePrivateDirectory, type TokenPilotPaths } from "./paths.js";

export const DEFAULT_CONFIG: TokenPilotConfig = {
  version: 1,
  defaultMode: "observe"
};

export function ensureConfig(paths: TokenPilotPaths): TokenPilotConfig {
  ensurePrivateDirectory(paths, paths.configDir);
  assertSafeStateFile(paths, paths.configFile);
  if (!fs.existsSync(paths.configFile)) {
    writeConfig(paths, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const parsed = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as TokenPilotConfig;
  if (parsed.version !== 1
    || !["observe", "balanced", "deep", "off"].includes(parsed.defaultMode)) {
    throw new Error(`Unsupported TokenPilot configuration: ${paths.configFile}`);
  }
  // Older local configs may contain provider paths. Never use or preserve
  // them: a mutable config must not become executable authority.
  return {
    version: 1,
    defaultMode: parsed.defaultMode
  };
}

export function writeConfig(paths: TokenPilotPaths, config: TokenPilotConfig): void {
  ensurePrivateDirectory(paths, paths.configDir);
  assertSafeStateFile(paths, paths.configFile);
  const temporary = path.join(paths.configDir, `.config-${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, paths.configFile);
}

export function setMode(paths: TokenPilotPaths, mode: RunMode): TokenPilotConfig {
  const config = ensureConfig(paths);
  config.defaultMode = mode;
  writeConfig(paths, config);
  return config;
}
