import type { RunRecord, SessionEvent, UsageRecord } from "./types.js";

const FORBIDDEN_KEYS = new Set([
  "prompt", "prompts", "response", "responses", "content", "text", "message", "messages",
  "command", "commands", "arguments", "args", "path", "paths", "token", "tokens", "secret", "credential", "code"
]);

export function assertTelemetrySafe(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new Error(`Refusing to store sensitive telemetry field: ${key}`);
    }
    assertTelemetrySafe(nested);
  }
}

export function safeRun(record: RunRecord): RunRecord {
  assertTelemetrySafe(record);
  return record;
}

export function safeUsage(record: UsageRecord): UsageRecord {
  assertTelemetrySafe(record);
  return record;
}

export function safeEvent(record: SessionEvent): SessionEvent {
  assertTelemetrySafe(record);
  return record;
}
