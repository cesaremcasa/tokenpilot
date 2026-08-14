import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider, RunMode, TokenPilotConfig } from "./types.js";
import type { TokenPilotPaths } from "./paths.js";

export const DEFAULT_CONFIG: TokenPilotConfig = {
  version: 1,
  defaultMode: "observe",
  balancedSamplingRate: 0.5,
  providers: {}
};

export function ensureConfig(paths: TokenPilotPaths): TokenPilotConfig {
  fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.configFile)) {
    writeConfig(paths, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const parsed = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as TokenPilotConfig;
  if (parsed.version !== 1 || !parsed.providers || !parsed.defaultMode) {
    throw new Error(`Unsupported TokenPilot configuration: ${paths.configFile}`);
  }
  return parsed;
}

export function writeConfig(paths: TokenPilotPaths, config: TokenPilotConfig): void {
  fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
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

export function selectMode(config: TokenPilotConfig, bypass: boolean, random = Math.random): RunMode {
  if (bypass || config.defaultMode === "off") return "off";
  if (config.defaultMode !== "balanced") return config.defaultMode;
  return random() < config.balancedSamplingRate ? "balanced" : "observe";
}

export function rememberProviderPath(paths: TokenPilotPaths, provider: Provider, originalPath: string): void {
  const config = ensureConfig(paths);
  config.providers[provider] = { ...config.providers[provider], originalPath };
  writeConfig(paths, config);
}
