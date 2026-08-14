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
  claude: adapter("claude", "otlp-metrics", "Personal Claude sessions use a per-run, metrics-only local OTLP receiver. Prompt, response, event, and trace export remain disabled.", true),
  codex: adapter("codex", "otlp-metrics", "Personal Codex sessions use a per-run, metrics-only local OTLP receiver through session-scoped --config settings. Logs, traces, and raw prompt export remain disabled.", true),
  grok: adapter("grok", "cli-json", "Grok single-turn JSON output exposes provider-published numeric usage and is collected only in that explicit non-interactive mode. Normal TTY sessions remain observe-only; do not assume API cache keys apply to the CLI.", true),
  kimi: adapter("kimi", "unknown", "Use validated session controls only when the installed CLI advertises them; otherwise observe without mutating Kimi config. Automatic telemetry remains disabled until a documented session correlation is validated.", true)
};

export function getAdapter(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}
