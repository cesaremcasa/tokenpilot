import type { AuditableSession } from "./types.js";

/** Render only the closed, content-free audit contract. */
export function renderSessions(rows: AuditableSession[]): string {
  const lines = ["Run ID                              Provider  Started              Mode      Policy                 Task        Outcome     Measurement  Basis              Total source             Price snapshot        Reason"];
  for (const row of rows) {
    lines.push(`${row.id}  ${row.provider.padEnd(8)}  ${row.startedAt.slice(0, 19)}  ${row.mode.padEnd(8)}  ${row.policy.padEnd(21)}  ${row.taskKind.padEnd(10)}  ${row.outcome.padEnd(10)}  ${row.measurement.padEnd(11)}  ${row.measurementBasis.padEnd(17)}  ${row.totalSource.padEnd(23)}  ${(row.pricingSnapshot ?? "none").padEnd(20)}  ${row.unavailableReason ?? "—"}`);
  }
  return `${lines.join("\n")}\n`;
}
