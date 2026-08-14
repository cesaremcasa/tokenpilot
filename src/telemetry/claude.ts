import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TelemetryDatabase } from "../database.js";
import type { UsageMetrics } from "../types.js";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_RESOURCE_METRICS = 8;
const MAX_SCOPE_METRICS = 16;
const MAX_METRICS = 32;
const MAX_DATA_POINTS = 256;
const METRIC_NAME = "claude_code.token.usage";
const SOURCE = "claude-otlp-metrics-v1";

type JsonObject = Record<string, unknown>;

export interface ClaudeMetricsReceiver {
  endpoint: string;
  headers: Record<string, string>;
  environment: Record<string, string>;
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

function pointType(value: unknown): "inputNew" | "inputCached" | "cacheCreated" | "output" | undefined {
  const attributes = limitedArray(object(value)?.attributes, 32);
  if (!attributes) return undefined;
  for (const attribute of attributes) {
    const entry = object(attribute);
    if (entry?.key !== "type") continue;
    const type = object(entry.value)?.stringValue;
    if (type === "input") return "inputNew";
    if (type === "cacheRead") return "inputCached";
    if (type === "cacheCreation") return "cacheCreated";
    if (type === "output") return "output";
  }
  return undefined;
}

function deltaSum(metric: JsonObject): JsonObject | undefined {
  const sum = object(metric.sum);
  if (!sum) return undefined;
  // OTLP protobuf JSON encodes this enum as 2. Some exporters emit the enum
  // name instead, so accept both documented representations. Never add a
  // cumulative counter: repeated exports would otherwise overstate usage.
  const temporality = sum.aggregationTemporality;
  if (temporality !== 2 && temporality !== "AGGREGATION_TEMPORALITY_DELTA") return undefined;
  return sum;
}

/**
 * Extracts only four numeric counters from the documented Claude OTLP metric.
 * All resource attributes and every unknown metric are deliberately ignored.
 */
export function parseClaudeOtlpMetrics(payload: unknown): UsageMetrics | undefined {
  const resources = limitedArray(object(payload)?.resourceMetrics, MAX_RESOURCE_METRICS);
  if (!resources) return undefined;
  const totals: Required<Pick<UsageMetrics, "inputNew" | "inputCached" | "cacheCreated" | "output">> = {
    inputNew: 0,
    inputCached: 0,
    cacheCreated: 0,
    output: 0
  };
  let found = false;

  for (const resourceMetric of resources) {
    const scopeMetrics = limitedArray(object(resourceMetric)?.scopeMetrics, MAX_SCOPE_METRICS);
    if (!scopeMetrics) return undefined;
    for (const scopeMetric of scopeMetrics) {
      const metrics = limitedArray(object(scopeMetric)?.metrics, MAX_METRICS);
      if (!metrics) return undefined;
      for (const metric of metrics) {
        const metricObject = object(metric);
        if (metricObject?.name !== METRIC_NAME) continue;
        const sum = deltaSum(metricObject);
        if (!sum) continue;
        const points = limitedArray(sum.dataPoints, MAX_DATA_POINTS);
        if (!points) return undefined;
        for (const point of points) {
          const type = pointType(point);
          const value = nonNegativeInteger(object(point)?.asInt ?? object(point)?.asDouble);
          if (!type || value === undefined) continue;
          totals[type] += value;
          if (!Number.isSafeInteger(totals[type])) return undefined;
          found = true;
        }
      }
    }
  }
  return found ? totals : undefined;
}

function writeResponse(response: http.ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("content-length", "0");
  response.end();
}

export async function startClaudeMetricsReceiver(database: TelemetryDatabase, runId: string): Promise<ClaudeMetricsReceiver> {
  const secret = randomBytes(32).toString("hex");
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
        const usage = parseClaudeOtlpMetrics(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        if (usage) {
          database.addUsage({ runId, observedAt: new Date().toISOString(), source: SOURCE, ...usage });
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
  return {
    endpoint,
    headers,
    environment: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_TOOL_DETAILS: "0",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_RAW_API_BODIES: "0",
      OTEL_METRICS_INCLUDE_SESSION_ID: "false",
      OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
      OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: "false",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-tokenpilot-metrics=" + secret,
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
      OTEL_METRIC_EXPORT_INTERVAL: "1000"
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
