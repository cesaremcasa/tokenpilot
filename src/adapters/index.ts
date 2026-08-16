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
  grok: adapter("grok", "otlp-metrics", "Grok Build 1.0.3+ normal TTY/TUI and headless sessions use its documented content-free External OTEL v1 token metrics. JSON single-turn is a fallback; API cache keys are never assumed for the CLI.", true),
  kimi: adapter("kimi", "wire", "Kimi 0.36.x text print sessions use its documented local REST/WS session channel with an ephemeral loopback password. Interactive TTY and unsupported print flags remain envelope-only and are never estimated.", true)
};

export function getAdapter(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}
