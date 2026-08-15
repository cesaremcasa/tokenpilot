import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPaths } from "../src/paths.js";

export function temporaryPaths(): ReturnType<typeof getPaths> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-test-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  return getPaths({
    HOME: home,
    TOKENPILOT_HOME: path.join(home, ".tokenpilot"),
    TOKENPILOT_CONFIG_HOME: path.join(home, ".config", "tokenpilot"),
    TOKENPILOT_DATA_HOME: path.join(home, ".local", "share", "tokenpilot")
  }, { allowEnvironmentOverrides: true });
}

export function cleanup(paths: ReturnType<typeof getPaths>): void {
  fs.rmSync(path.dirname(paths.userHome), { recursive: true, force: true });
}

function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function protobufField(number: number, wire: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((number << 3) | wire), wire === 2 ? varint(payload.length) : Buffer.alloc(0), payload]);
}

function protobufString(number: number, value: string): Buffer {
  return protobufField(number, 2, Buffer.from(value));
}

function protobufMessage(number: number, value: Buffer): Buffer {
  return protobufField(number, 2, value);
}

function protobufVarint(number: number, value: number): Buffer {
  return protobufField(number, 0, varint(value));
}

function protobufFixed64(number: number, value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(BigInt(value));
  return protobufField(number, 1, encoded);
}

function otlpAttribute(key: string, value: string): Buffer {
  return Buffer.concat([protobufString(1, key), protobufMessage(2, protobufString(1, value))]);
}

/** Content-bearing resource data is deliberate test noise; production discards it. */
export function grokOtlpFixture(values: Record<string, number>, temporality = 1): Buffer {
  const points = Object.entries(values).map(([type, value]) => protobufMessage(1, Buffer.concat([
    protobufMessage(7, otlpAttribute("type", type)),
    protobufFixed64(6, value)
  ])));
  const sum = Buffer.concat([...points, protobufVarint(2, temporality), protobufVarint(3, 1)]);
  const metric = Buffer.concat([protobufString(1, "grok_code.token.usage"), protobufMessage(7, sum)]);
  const privateResource = protobufMessage(1, protobufMessage(1, otlpAttribute("user.email", "person@example.test")));
  return protobufMessage(1, Buffer.concat([privateResource, protobufMessage(2, protobufMessage(2, metric))]));
}
