import type { Provider, ProviderAdapter } from "../types.js";
import { parseUsageLine } from "./parser.js";

function adapter(
  provider: Provider,
  telemetry: ProviderAdapter["capabilities"]["telemetry"],
  notes: string,
  supportsBalancedOptimization: boolean
): ProviderAdapter {
  return {
    provider,
    capabilities: {
      telemetry,
      supportsBalancedOptimization,
      notes
    },
    parseTelemetryLine: parseUsageLine
  };
}

export const ADAPTERS: Record<Provider, ProviderAdapter> = {
  claude: adapter("claude", "unknown", "Use validated cache-prefix, effort, and core-tool controls when the installed CLI advertises them. Automatic telemetry remains disabled until a documented session correlation is validated.", true),
  codex: adapter("codex", "unknown", "Use validated session-only reasoning, verbosity, and compaction controls when --config is available. Automatic telemetry remains disabled until a documented session correlation is validated.", true),
  grok: adapter("grok", "unknown", "Use a validated CLI reasoning-effort control; do not assume API cache keys apply to the CLI. Automatic telemetry remains disabled until a documented session correlation is validated.", true),
  kimi: adapter("kimi", "unknown", "Use validated session controls only when the installed CLI advertises them; otherwise observe without mutating Kimi config. Automatic telemetry remains disabled until a documented session correlation is validated.", true)
};

export function getAdapter(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}
