import type { UsageMetrics } from "../types.js";

const MAX_INCOMPLETE_LINE = 256;
const USAGE_START = /^"usage"\s*:\s*\{$/;
const USAGE_VALUE = /^"(input_tokens|cache_read_input_tokens|cache_creation_input_tokens|output_tokens|reasoning_tokens|total_tokens)"\s*:\s*(\d+),?$/;

const METRIC_KEYS: Record<string, keyof UsageMetrics> = {
  input_tokens: "inputNew",
  cache_read_input_tokens: "inputCached",
  cache_creation_input_tokens: "cacheCreated",
  output_tokens: "output",
  reasoning_tokens: "reasoning",
  total_tokens: "reportedTotal"
};

/**
 * Parses only Grok's documented numeric `usage` object from its pretty JSON
 * single-turn output. It never parses or retains JSON text/thought fields.
 */
export class GrokJsonUsageParser {
  private pending = "";
  private insideUsage = false;
  private readonly usage: UsageMetrics = {};

  accept(chunk: Buffer | string): void {
    const text = this.pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const lines = text.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    if (this.pending.length > MAX_INCOMPLETE_LINE) this.pending = "";
    for (const line of lines) this.acceptLine(line);
  }

  finish(): UsageMetrics | undefined {
    if (this.pending) this.acceptLine(this.pending);
    this.pending = "";
    return Object.keys(this.usage).length > 0 ? { ...this.usage } : undefined;
  }

  private acceptLine(line: string): void {
    const normalized = line.trim();
    if (!this.insideUsage) {
      if (USAGE_START.test(normalized)) this.insideUsage = true;
      return;
    }
    if (normalized === "}") {
      this.insideUsage = false;
      return;
    }
    const match = normalized.match(USAGE_VALUE);
    if (!match) return;
    const metric = METRIC_KEYS[match[1]];
    const value = Number(match[2]);
    if (metric && Number.isSafeInteger(value) && value >= 0) this.usage[metric] = value;
  }
}

/** A JSON single turn is non-interactive, so observing its output preserves TTY behavior. */
export function isGrokJsonSingle(args: string[]): boolean {
  const outputIndex = args.findIndex((argument) => argument === "--output-format");
  const jsonOutput = (outputIndex >= 0 && args[outputIndex + 1] === "json") || args.includes("--output-format=json");
  return jsonOutput && (args.includes("--single") || args.includes("-p"));
}
