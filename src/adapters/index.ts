import path from "node:path";
import type { Provider, ProviderAdapter } from "../types.js";
import { parseUsageLine } from "./parser.js";

function adapter(
  provider: Provider,
  telemetry: ProviderAdapter["capabilities"]["telemetry"],
  paths: string[],
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
    telemetryRoots(homeDir: string): string[] {
      return paths.map((item) => path.join(homeDir, item));
    },
    parseTelemetryLine: parseUsageLine
  };
}

export const ADAPTERS: Record<Provider, ProviderAdapter> = {
  claude: adapter("claude", "session-files", [".claude", ".config/claude"], "Use validated cache-prefix, effort, and core-tool controls when the installed CLI advertises them.", true),
  codex: adapter("codex", "session-files", [".codex/sessions"], "Use validated session-only reasoning, verbosity, and compaction controls when --config is available.", true),
  grok: adapter("grok", "session-files", [".grok/sessions"], "Use a validated CLI reasoning-effort control; do not assume API cache keys apply to the CLI.", true),
  kimi: adapter("kimi", "wire", [".kimi-code/sessions", ".kimi/sessions"], "Use validated session controls only when the installed CLI advertises them; otherwise observe without mutating Kimi config.", true)
};

export function getAdapter(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}
