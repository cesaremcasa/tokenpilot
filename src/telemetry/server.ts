import type { Server } from "node:http";

export const MAX_LOOPBACK_RECEIVER_CONNECTIONS = 32;

/** Apply the same bounded admission policy to every local metrics receiver. */
export function configureLoopbackReceiver(server: Server): void {
  server.maxConnections = MAX_LOOPBACK_RECEIVER_CONNECTIONS;
  server.headersTimeout = 2_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
}
