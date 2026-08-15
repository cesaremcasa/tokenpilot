import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PricingProfile, RunMode, TokenPilotConfig } from "./types.js";
import { isPricingProfile, pricingProfile, upsertPricingProfile } from "./pricing.js";
import { assertSafeStateFile, ensurePrivateDirectory, type TokenPilotPaths } from "./paths.js";

export const DEFAULT_CONFIG: TokenPilotConfig = {
  version: 2,
  defaultMode: "balanced",
  pricingProfiles: [],
  activePricing: {}
};

export function ensureConfig(paths: TokenPilotPaths): TokenPilotConfig {
  ensurePrivateDirectory(paths, paths.configDir);
  assertSafeStateFile(paths, paths.configFile);
  if (!fs.existsSync(paths.configFile)) {
    writeConfig(paths, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const parsed = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as Partial<TokenPilotConfig> & { version?: number };
  if (![1, 2].includes(parsed.version ?? 0)
    || !["observe", "balanced", "deep", "off"].includes(parsed.defaultMode ?? "")) {
    throw new Error(`Unsupported TokenPilot configuration: ${paths.configFile}`);
  }
  // Older local configs may contain provider paths. Never use or preserve
  // them: a mutable config must not become executable authority.
  return {
    version: 2,
    defaultMode: parsed.defaultMode as RunMode,
    pricingProfiles: Array.isArray(parsed.pricingProfiles) ? parsed.pricingProfiles.filter(isPricingProfile) : [],
    activePricing: Object.fromEntries(Object.entries(parsed.activePricing ?? {})
      .filter(([provider, id]) => ["claude", "codex", "grok", "kimi"].includes(provider) && typeof id === "string"))
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

export function listPricing(paths: TokenPilotPaths): PricingProfile[] {
  return ensureConfig(paths).pricingProfiles;
}

export function addPricing(paths: TokenPilotPaths, profile: PricingProfile): TokenPilotConfig {
  const config = upsertPricingProfile(ensureConfig(paths), profile);
  writeConfig(paths, config);
  return config;
}

export function setPricing(paths: TokenPilotPaths, provider: PricingProfile["provider"], id: string): TokenPilotConfig {
  const config = ensureConfig(paths);
  if (!config.pricingProfiles.some((profile) => profile.provider === provider && profile.id === id)) {
    throw new Error(`Pricing profile not found for ${provider}: ${id}`);
  }
  config.activePricing[provider] = id;
  writeConfig(paths, config);
  return config;
}

export function disablePricing(paths: TokenPilotPaths, provider: PricingProfile["provider"]): TokenPilotConfig {
  const config = ensureConfig(paths);
  delete config.activePricing[provider];
  writeConfig(paths, config);
  return config;
}

export function activePricing(paths: TokenPilotPaths, provider: PricingProfile["provider"]): PricingProfile | undefined {
  return pricingProfile(ensureConfig(paths), provider);
}
