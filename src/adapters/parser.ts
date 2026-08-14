import type { ParsedTelemetry, UsageMetrics } from "../types.js";

const NUMBER_KEYS: Record<keyof UsageMetrics, string[]> = {
  inputNew: ["input_tokens", "input_other", "inputother", "inputnew", "input_tokens_excluding_cache"],
  inputCached: ["cache_read_input_tokens", "cached_input_tokens", "input_cache_read", "inputcacheread", "cached_tokens"],
  cacheCreated: ["cache_creation_input_tokens", "input_cache_creation", "inputcachecreation", "cache_write_input_tokens"],
  output: ["output_tokens", "output", "outputtokens"],
  reasoning: ["reasoning_output_tokens", "reasoning_tokens", "reasoning", "reasoningoutputtokens"],
  modelCalls: ["model_calls", "num_turns", "num_requests", "requests"]
};

function normaliseKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toLowerCase();
}

function recordNumericFields(value: unknown, usage: UsageMetrics, events: ParsedTelemetry["events"], depth = 0): void {
  if (depth > 12 || value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) recordNumericFields(item, usage, events, depth + 1);
    return;
  }

  for (const [rawKey, nested] of Object.entries(value as Record<string, unknown>)) {
    const key = normaliseKey(rawKey);
    if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) {
      for (const [metric, aliases] of Object.entries(NUMBER_KEYS) as Array<[keyof UsageMetrics, string[]]>) {
        if (aliases.includes(key)) usage[metric] = nested;
      }
      if (key === "compaction_count") events.push({ type: "compaction", count: nested });
      if (key === "retry_count") events.push({ type: "retry", count: nested });
    }

    if (typeof nested === "string") {
      const label = `${key}:${nested}`.toLowerCase();
      if (label.includes("compaction")) events.push({ type: "compaction", count: 1 });
      if (label.includes("retry")) events.push({ type: "retry", count: 1 });
      if (label.includes("model") && label.includes("switch")) events.push({ type: "model_switch", count: 1 });
      continue;
    }
    recordNumericFields(nested, usage, events, depth + 1);
  }
}

/**
 * Reads numeric counters only. Parsed source text is discarded immediately and is never persisted.
 */
export function parseUsageLine(line: string): ParsedTelemetry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  const usage: UsageMetrics = {};
  const events: ParsedTelemetry["events"] = [];
  recordNumericFields(parsed, usage, events);
  return Object.keys(usage).length > 0 || events.length > 0 ? { usage, events } : undefined;
}
