import type { PricingProfile, PricingRates, Provider, TokenPilotConfig } from "./types.js";

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_RATE = 1_000_000;

function validRate(value: unknown, optional = false): value is number | undefined {
  return optional && value === undefined
    ? true
    : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RATE;
}

export function isPricingProfile(value: unknown): value is PricingProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<PricingProfile>;
  const rates = profile.rates as Partial<PricingRates> | undefined;
  return typeof profile.id === "string" && PROFILE_ID.test(profile.id)
    && typeof profile.provider === "string" && ["claude", "codex", "grok", "kimi"].includes(profile.provider)
    && typeof profile.version === "string" && PROFILE_VERSION.test(profile.version)
    && typeof profile.label === "string" && profile.label.length > 0 && profile.label.length <= 80 && !/[\u0000-\u001f\u007f]/.test(profile.label)
    && profile.currency === "USD"
    && Boolean(rates)
    && validRate(rates?.inputUsdPerMillion)
    && validRate(rates?.cachedInputUsdPerMillion)
    && validRate(rates?.cacheCreationUsdPerMillion)
    && validRate(rates?.outputUsdPerMillion)
    && validRate(rates?.reasoningUsdPerMillion, true);
}

export function pricingProfile(config: TokenPilotConfig, provider: Provider): PricingProfile | undefined {
  const id = config.activePricing[provider];
  if (!id) return undefined;
  const profile = config.pricingProfiles.find((candidate) => candidate.provider === provider && candidate.id === id);
  return profile ? structuredClone(profile) : undefined;
}

export function upsertPricingProfile(config: TokenPilotConfig, profile: PricingProfile): TokenPilotConfig {
  if (!isPricingProfile(profile)) throw new Error("Invalid pricing profile");
  const profiles = config.pricingProfiles.filter((candidate) => !(candidate.provider === profile.provider && candidate.id === profile.id));
  return { ...config, pricingProfiles: [...profiles, structuredClone(profile)] };
}
