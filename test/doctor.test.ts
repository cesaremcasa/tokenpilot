import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { doctor, doctorMarkdown } from "../src/doctor.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("doctor", () => {
  it("inspects readiness without creating TokenPilot configuration or telemetry", () => {
    const paths = temporaryPaths();
    const report = doctor(paths, { platform: "linux", nodeVersion: "22.5.0", pathValue: "" });
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Platform and Node", status: "ready" }),
      expect.objectContaining({ name: "Wrappers and PATH", status: "warning" }),
      expect.objectContaining({ name: "codex CLI", status: "unavailable" })
    ]));
    expect(doctorMarkdown(report)).toContain("# TokenPilot doctor");
    expect(fs.existsSync(paths.configFile)).toBe(false);
    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    expect(fs.existsSync(paths.shimDir)).toBe(false);
    cleanup(paths);
  });

  it("reports an unsupported platform with an actionable correction", () => {
    const paths = temporaryPaths();
    const report = doctor(paths, { platform: "win32", nodeVersion: "22.5.0", pathValue: "" });
    expect(report.checks[0]).toMatchObject({ status: "unavailable", fix: expect.stringContaining("macOS or Linux") });
    cleanup(paths);
  });
});
