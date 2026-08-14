import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TelemetryDatabase } from "../database.js";
import type { UsageMetrics } from "../types.js";

/**
 * Codex `exec` prints a final, provider-published total as two terminal
 * lines: `tokens used` and a number. This parser retains neither the prompt
 * nor response: it recognises those two exact lines, keeps at most one short
 * incomplete line while a stream chunk is split, and returns just a number.
 */
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const MAX_INCOMPLETE_LINE = 128;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_RESOURCE_METRICS = 8;
const MAX_SCOPE_METRICS = 16;
const MAX_METRICS = 64;
const MAX_DATA_POINTS = 256;
const METRIC_NAME = "codex.turn.token_usage";
const SOURCE = "codex-otlp-metrics-v1";

type JsonObject = Record<string, unknown>;
type CodexTokenType = "input" | "cached_input" | "cache_write_input" | "output" | "reasoning_output" | "total";
type CodexRawUsage = Partial<Record<CodexTokenType, number>>;

export interface CodexMetricsReceiver {
  endpoint: string;
  headers: Record<string, string>;
  /** Session-scoped Codex configuration. It never edits ~/.codex/config.toml. */
  args: string[];
  close(): Promise<void>;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function limitedArray(value: unknown, limit: number): unknown[] | undefined {
  return Array.isArray(value) && value.length <= limit ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d{1,16}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function tokenType(point: unknown): CodexTokenType | undefined {
  const attributes = limitedArray(object(point)?.attributes, 32);
  if (!attributes) return undefined;
  for (const attribute of attributes) {
    const entry = object(attribute);
    if (entry?.key !== "token_type") continue;
    const value = object(entry.value)?.stringValue;
    if (value === "input" || value === "cached_input" || value === "cache_write_input" || value === "output" || value === "reasoning_output" || value === "total") return value;
  }
  return undefined;
}

function temporality(metric: JsonObject): "delta" | "cumulative" | undefined {
  const histogram = object(metric.histogram);
  if (!histogram) return undefined;
  const value = histogram.aggregationTemporality;
  if (value === 1 || value === "AGGREGATION_TEMPORALITY_DELTA") return "delta";
  if (value === 2 || value === "AGGREGATION_TEMPORALITY_CUMULATIVE") return "cumulative";
  return undefined;
}

function addRaw(target: CodexRawUsage, addition: CodexRawUsage): void {
  for (const key of ["input", "cached_input", "cache_write_input", "output", "reasoning_output", "total"] as const) {
    const value = addition[key];
    if (value === undefined) continue;
    const next = (target[key] ?? 0) + value;
    if (!Number.isSafeInteger(next)) throw new Error("Codex metric total exceeded safe integer range");
    target[key] = next;
  }
}

function deltaFromCumulative(snapshot: CodexRawUsage, current: CodexRawUsage): CodexRawUsage {
  const delta: CodexRawUsage = {};
  for (const key of ["input", "cached_input", "cache_write_input", "output", "reasoning_output", "total"] as const) {
    const value = current[key];
    if (value === undefined) continue;
    const previous = snapshot[key];
    const difference = previous === undefined || value < previous ? value : value - previous;
    if (!Number.isSafeInteger(difference) || difference < 0) throw new Error("Invalid cumulative Codex metric");
    snapshot[key] = value;
    delta[key] = difference;
  }
  return delta;
}

function usageFromRaw(raw: CodexRawUsage): UsageMetrics | undefined {
  const usage: UsageMetrics = {};
  const input = raw.input;
  const cached = raw.cached_input;
  if (input !== undefined) {
    if (cached !== undefined && cached > input) return undefined;
    // Codex reports `input` as the full input total and `cached_input` as its
    // cache-hit component. Store new context only once, separately from hits.
    usage.inputNew = input - (cached ?? 0);
  }
  if (cached !== undefined) usage.inputCached = cached;
  if (raw.cache_write_input !== undefined) usage.cacheCreated = raw.cache_write_input;
  if (raw.output !== undefined) usage.output = raw.output;
  if (raw.reasoning_output !== undefined) usage.reasoning = raw.reasoning_output;
  if (raw.total !== undefined) usage.reportedTotal = raw.total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export interface CodexMetricSamples {
  delta: CodexRawUsage;
  cumulative: CodexRawUsage;
}

/**
 * Reads only Codex's published `codex.turn.token_usage` histogram and only
 * its numeric sums. Resource attributes, model names, session IDs, prompts,
 * tool data, logs, and traces are ignored before storage.
 */
export function parseCodexOtlpMetricSamples(payload: unknown): CodexMetricSamples | undefined {
  const resources = limitedArray(object(payload)?.resourceMetrics, MAX_RESOURCE_METRICS);
  if (!resources) return undefined;
  const totals: CodexMetricSamples = { delta: {}, cumulative: {} };
  let found = false;
  for (const resource of resources) {
    const scopes = limitedArray(object(resource)?.scopeMetrics, MAX_SCOPE_METRICS);
    if (!scopes) return undefined;
    for (const scope of scopes) {
      const metrics = limitedArray(object(scope)?.metrics, MAX_METRICS);
      if (!metrics) return undefined;
      for (const metric of metrics) {
        const metricObject = object(metric);
        if (metricObject?.name !== METRIC_NAME) continue;
        const kind = temporality(metricObject);
        const points = limitedArray(object(metricObject.histogram)?.dataPoints, MAX_DATA_POINTS);
        if (!kind || !points) continue;
        for (const point of points) {
          const type = tokenType(point);
          const value = nonNegativeInteger(object(point)?.sum);
          if (!type || value === undefined) continue;
          const bucket = totals[kind];
          const next = (bucket[type] ?? 0) + value;
          if (!Number.isSafeInteger(next)) return undefined;
          bucket[type] = next;
          found = true;
        }
      }
    }
  }
  return found ? totals : undefined;
}

export function parseCodexOtlpMetrics(payload: unknown): UsageMetrics | undefined {
  return usageFromRaw(parseCodexOtlpMetricSamples(payload)?.delta ?? {});
}

function writeResponse(response: http.ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("content-length", "0");
  response.end();
}

export async function startCodexMetricsReceiver(database: TelemetryDatabase, runId: string): Promise<CodexMetricsReceiver> {
  const secret = randomBytes(32).toString("hex");
  const cumulativeSnapshot: CodexRawUsage = {};
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/metrics" || request.headers["x-tokenpilot-metrics"] !== secret) {
      request.resume();
      writeResponse(response, 404);
      return;
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.startsWith("application/json")) {
      request.resume();
      writeResponse(response, 415);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        const samples = parseCodexOtlpMetricSamples(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        if (samples) {
          const raw: CodexRawUsage = {};
          addRaw(raw, samples.delta);
          addRaw(raw, deltaFromCumulative(cumulativeSnapshot, samples.cumulative));
          const usage = usageFromRaw(raw);
          if (usage) database.addUsage({ runId, observedAt: new Date().toISOString(), source: SOURCE, ...usage });
        }
        writeResponse(response, 200);
      } catch {
        writeResponse(response, 400);
      }
    });
    request.on("error", () => {
      if (!response.headersSent) response.destroy();
    });
  });
  server.headersTimeout = 2_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
  const endpoint = `http://127.0.0.1:${address.port}/v1/metrics`;
  const headers = { "x-tokenpilot-metrics": secret };
  // Codex accepts this documented, session-only config form. Metric export is
  // local and authenticated; logs, traces, and raw user-prompt export are off.
  const metricsConfig = `otel.metrics_exporter={ "otlp-http" = { endpoint = "${endpoint}", headers = { "x-tokenpilot-metrics" = "${secret}" }, protocol = "json" } }`;
  return {
    endpoint,
    headers,
    args: [
      "--config", metricsConfig,
      "--config", "otel.exporter=\"none\"",
      "--config", "otel.trace_exporter=\"none\"",
      "--config", "otel.log_user_prompt=false"
    ],
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function parseTotal(line: string): number | undefined {
  if (!/^\d[\d,]*$/.test(line)) return undefined;
  const total = Number(line.replaceAll(",", ""));
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

export class CodexExecTokenParser {
  private pending = "";
  private expectsTotal = false;
  private total: number | undefined;

  accept(chunk: Buffer | string): void {
    const text = this.pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const lines = text.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    if (this.pending.length > MAX_INCOMPLETE_LINE) this.pending = "";
    for (const line of lines) this.acceptLine(line);
  }

  finish(): number | undefined {
    if (this.pending) this.acceptLine(this.pending);
    this.pending = "";
    return this.total;
  }

  private acceptLine(line: string): void {
    const normalized = line.replace(ANSI_ESCAPE, "").trim();
    if (normalized === "tokens used") {
      this.expectsTotal = true;
      return;
    }
    if (this.expectsTotal) {
      this.expectsTotal = false;
      const total = parseTotal(normalized);
      if (total !== undefined) this.total = total;
    }
  }
}

/** `codex exec` is non-interactive, so piped output cannot alter its TTY UI. */
export function isCodexExec(args: string[]): boolean {
  return args[0] === "exec";
}
