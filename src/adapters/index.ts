import path from "node:path";
import type { Provider, ProviderAdapter } from "../types.js";
import { parseUsageLine } from "./parser.js";

function adapter(
  provider: Provider,
  telemetry: ProviderAdapter["capabilities"]["telemetry"],
  paths: string[],
  notes: string
): ProviderAdapter {
  return {
    provider,
    capabilities: {
      telemetry,
      // V1 intentionally applies no CLI mutation until a provider-specific experiment validates it.
      supportsBalancedOptimization: false,
      notes
    },
    telemetryRoots(homeDir: string): string[] {
      return paths.map((item) => path.join(homeDir, item));
    },
    parseTelemetryLine: parseUsageLine
  };
}

export const ADAPTERS: Record<Provider, ProviderAdapter> = {
  claude: adapter("claude", "session-files", [".claude", ".config/claude"], "Observe local Claude session metrics only."),
  codex: adapter("codex", "session-files", [".codex/sessions"], "Observe local Codex rollout metrics only."),
  grok: adapter("grok", "session-files", [".grok/sessions"], "Observe local Grok session metrics only."),
  kimi: adapter("kimi", "wire", [".kimi-code/sessions", ".kimi/sessions"], "Observe Kimi session and Wire metrics only.")
};

export function getAdapter(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}
