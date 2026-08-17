import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TelemetryDatabase } from "../database.js";
import type { UsageMetrics } from "../types.js";
import { configureLoopbackReceiver } from "./server.js";

const MAX_INCOMPLETE_LINE = 256;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_PROTO_FIELDS = 4_096;
const MAX_RESOURCE_METRICS = 8;
const MAX_SCOPE_METRICS = 16;
const MAX_METRICS = 64;
const MAX_DATA_POINTS = 512;
const OTLP_METRIC_NAME = "grok_code.token.usage";
const OTLP_SOURCE = "grok-otlp-metrics-v2";
const USAGE_START = /^"usage"\s*:\s*\{$/;
const USAGE_VALUE = /^"(input_tokens|cache_read_input_tokens|cache_creation_input_tokens|output_tokens|reasoning_tokens|total_tokens)"\s*:\s*(\d+),?$/;

const METRIC_KEYS: Record<string, Exclude<keyof UsageMetrics, "reportedTotalIncludesCachedInput">> = {
  input_tokens: "inputNew",
  cache_read_input_tokens: "inputCached",
  cache_creation_input_tokens: "cacheCreated",
  output_tokens: "output",
  reasoning_tokens: "reasoning",
  total_tokens: "reportedTotal"
};

type GrokUsageKey = "inputTotal" | "inputCached" | "output" | "reasoning";
type GrokRawUsage = Partial<Record<GrokUsageKey, number>>;

interface ProtoField {
  number: number;
  wire: 0 | 1 | 2 | 5;
  varint?: bigint;
  bytes?: Buffer;
}

export interface GrokMetricSamples {
  delta: GrokRawUsage;
  cumulative: GrokRawUsage;
}

export interface GrokMetricsReceiver {
  endpoint: string;
  headers: Record<string, string>;
  environment: Record<string, string>;
  close(): Promise<void>;
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10 && offset + index < buffer.length; index += 1) {
    const byte = buffer[offset + index];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
    shift += 7n;
  }
  return undefined;
}

/** Minimal bounded protobuf wire reader for the documented OTLP metric only. */
function protoFields(buffer: Buffer): ProtoField[] | undefined {
  const result: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (result.length >= MAX_PROTO_FIELDS) return undefined;
    const tag = readVarint(buffer, offset);
    if (!tag) return undefined;
    offset = tag.next;
    const fieldNumber = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber < 1 || ![0, 1, 2, 5].includes(wire)) return undefined;
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      if (!value) return undefined;
      result.push({ number: fieldNumber, wire: 0, varint: value.value });
      offset = value.next;
      continue;
    }
    if (wire === 1) {
      if (offset + 8 > buffer.length) return undefined;
      result.push({ number: fieldNumber, wire: 1, bytes: buffer.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wire === 5) {
      if (offset + 4 > buffer.length) return undefined;
      result.push({ number: fieldNumber, wire: 5, bytes: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const length = readVarint(buffer, offset);
    if (!length || length.value > BigInt(MAX_BODY_BYTES)) return undefined;
    const size = Number(length.value);
    offset = length.next;
    if (!Number.isSafeInteger(size) || offset + size > buffer.length) return undefined;
    result.push({ number: fieldNumber, wire: 2, bytes: buffer.subarray(offset, offset + size) });
    offset += size;
  }
  return result;
}

function childMessages(fields: ProtoField[], number: number, limit: number): Buffer[] | undefined {
  const values = fields.filter((field) => field.number === number && field.wire === 2 && field.bytes).map((field) => field.bytes!);
  return values.length <= limit ? values : undefined;
}

function stringField(fields: ProtoField[], number: number, maxBytes = 128): string | undefined {
  const field = fields.find((candidate) => candidate.number === number && candidate.wire === 2 && candidate.bytes && candidate.bytes.length <= maxBytes);
  return field?.bytes?.toString("utf8");
}

function pointType(point: Buffer): GrokUsageKey | undefined {
  const fields = protoFields(point);
  if (!fields) return undefined;
  const attributes = childMessages(fields, 7, 32);
  if (!attributes) return undefined;
  for (const attribute of attributes) {
    const keyValue = protoFields(attribute);
    if (!keyValue || stringField(keyValue, 1, 32) !== "type") continue;
    const encodedValue = childMessages(keyValue, 2, 1)?.[0];
    const anyValue = encodedValue ? protoFields(encodedValue) : undefined;
    const value = anyValue ? stringField(anyValue, 1, 32) : undefined;
    if (value === "input") return "inputTotal";
    if (value === "cache_read") return "inputCached";
    if (value === "output") return "output";
    if (value === "reasoning") return "reasoning";
  }
  return undefined;
}

function pointValue(point: Buffer): number | undefined {
  const fields = protoFields(point);
  if (!fields) return undefined;
  const integer = fields.find((field) => field.number === 6 && field.wire === 1)?.bytes;
  if (integer) {
    const value = integer.readBigUInt64LE(0);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  const double = fields.find((field) => field.number === 4 && field.wire === 1)?.bytes;
  if (!double) return undefined;
  const value = double.readDoubleLE(0);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function addRaw(target: GrokRawUsage, addition: GrokRawUsage): void {
  for (const key of ["inputTotal", "inputCached", "output", "reasoning"] as const) {
    const value = addition[key];
    if (value === undefined) continue;
    const next = (target[key] ?? 0) + value;
    if (!Number.isSafeInteger(next)) throw new Error("Grok metric total exceeded safe integer range");
    target[key] = next;
  }
}

function deltaFromCumulative(snapshot: GrokRawUsage, current: GrokRawUsage): GrokRawUsage {
  const delta: GrokRawUsage = {};
  for (const key of ["inputTotal", "inputCached", "output", "reasoning"] as const) {
    const value = current[key];
    if (value === undefined) continue;
    const previous = snapshot[key];
    const difference = previous === undefined || value < previous ? value : value - previous;
    if (!Number.isSafeInteger(difference) || difference < 0) throw new Error("Invalid cumulative Grok metric");
    snapshot[key] = value;
    delta[key] = difference;
  }
  return delta;
}

function completeUsage(raw: GrokRawUsage): UsageMetrics | undefined {
  if (Object.keys(raw).length === 0) return undefined;
  const inputTotal = raw.inputTotal ?? 0;
  const inputCached = raw.inputCached ?? 0;
  if (inputCached > inputTotal) return undefined;
  // External OTEL v1 defines input, cache_read, output, and reasoning as the
  // complete Grok token categories. Its input counter includes cache reads,
  // unlike the headless JSON input_tokens field, so subtract that component
  // before storing new input. Grok has no separately billed cache-write
  // category, so cacheCreated is explicitly not applicable (zero), not guessed.
  return {
    inputNew: inputTotal - inputCached,
    inputCached,
    cacheCreated: 0,
    output: raw.output ?? 0,
    reasoning: raw.reasoning ?? 0
  };
}

/**
 * Parse only `grok_code.token.usage` from an OTLP protobuf request. Resource,
 * identity, model, session, and all non-numeric attributes are discarded.
 */
export function parseGrokOtlpMetricSamples(payload: Buffer): GrokMetricSamples | undefined {
  if (payload.length === 0 || payload.length > MAX_BODY_BYTES) return undefined;
  const root = protoFields(payload);
  const resources = root ? childMessages(root, 1, MAX_RESOURCE_METRICS) : undefined;
  if (!resources) return undefined;
  const totals: GrokMetricSamples = { delta: {}, cumulative: {} };
  let found = false;
  for (const resource of resources) {
    const resourceFields = protoFields(resource);
    const scopes = resourceFields ? childMessages(resourceFields, 2, MAX_SCOPE_METRICS) : undefined;
    if (!scopes) return undefined;
    for (const scope of scopes) {
      const scopeFields = protoFields(scope);
      const metrics = scopeFields ? childMessages(scopeFields, 2, MAX_METRICS) : undefined;
      if (!metrics) return undefined;
      for (const metric of metrics) {
        const metricFields = protoFields(metric);
        if (!metricFields || stringField(metricFields, 1) !== OTLP_METRIC_NAME) continue;
        const encodedSum = childMessages(metricFields, 7, 1)?.[0];
        const sumFields = encodedSum ? protoFields(encodedSum) : undefined;
        if (!sumFields) continue;
        const temporalityValue = sumFields.find((field) => field.number === 2 && field.wire === 0)?.varint;
        const temporality = temporalityValue === 1n ? "delta" : temporalityValue === 2n ? "cumulative" : undefined;
        const points = childMessages(sumFields, 1, MAX_DATA_POINTS);
        if (!temporality || !points) continue;
        for (const point of points) {
          const type = pointType(point);
          const value = pointValue(point);
          if (!type || value === undefined) continue;
          const bucket = totals[temporality];
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

export function parseGrokOtlpMetrics(payload: Buffer): UsageMetrics | undefined {
  return completeUsage(parseGrokOtlpMetricSamples(payload)?.delta ?? {});
}

function writeResponse(response: http.ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("content-length", "0");
  response.end();
}

export function supportsGrokExternalOtelVersion(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [1, 0, 3];
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export async function startGrokMetricsReceiver(database: TelemetryDatabase, runId: string): Promise<GrokMetricsReceiver> {
  const secret = randomBytes(32).toString("hex");
  const cumulativeSnapshot: GrokRawUsage = {};
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/metrics" || request.headers["x-tokenpilot-metrics"] !== secret) {
      request.resume();
      writeResponse(response, 404);
      return;
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || (!contentType.startsWith("application/x-protobuf") && !contentType.startsWith("application/protobuf"))) {
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
        const samples = parseGrokOtlpMetricSamples(Buffer.concat(chunks));
        if (samples) {
          const raw: GrokRawUsage = {};
          addRaw(raw, samples.delta);
          addRaw(raw, deltaFromCumulative(cumulativeSnapshot, samples.cumulative));
          const usage = completeUsage(raw);
          if (usage) database.addUsage({ runId, observedAt: new Date().toISOString(), source: OTLP_SOURCE, ...usage });
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
  configureLoopbackReceiver(server);
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
  const collectorEndpoint = `http://127.0.0.1:${address.port}`;
  const endpoint = `${collectorEndpoint}/v1/metrics`;
  const header = `x-tokenpilot-metrics=${secret}`;
  return {
    endpoint,
    headers: { "x-tokenpilot-metrics": secret },
    environment: {
      GROK_EXTERNAL_OTEL: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: collectorEndpoint,
      OTEL_EXPORTER_OTLP_HEADERS: header,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: header,
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
      OTEL_METRIC_EXPORT_INTERVAL: "1000",
      OTEL_METRICS_INCLUDE_SESSION_ID: "0",
      OTEL_METRICS_INCLUDE_VERSION: "0",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_DETAILS: "0"
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

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
    if (Object.keys(this.usage).length === 0) return undefined;
    // Grok's JSON `total_tokens` is emitted alongside the input/cache/output
    // categories. The adapter records that it includes cached input only for
    // this documented envelope, never by assuming an API cache-key contract.
    return this.usage.reportedTotal === undefined
      ? { ...this.usage }
      : { ...this.usage, reportedTotalIncludesCachedInput: true };
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
