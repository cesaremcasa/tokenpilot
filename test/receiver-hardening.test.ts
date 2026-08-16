import http from "node:http";
import { describe, expect, it } from "vitest";
import { configureLoopbackReceiver, MAX_LOOPBACK_RECEIVER_CONNECTIONS } from "../src/telemetry/server.js";

describe("loopback receiver hardening", () => {
  it("applies aggregate admission and finite request limits", () => {
    const server = http.createServer();
    configureLoopbackReceiver(server);

    expect(server.maxConnections).toBe(MAX_LOOPBACK_RECEIVER_CONNECTIONS);
    expect(server.headersTimeout).toBe(2_000);
    expect(server.requestTimeout).toBe(5_000);
    expect(server.keepAliveTimeout).toBe(1_000);
  });
});
