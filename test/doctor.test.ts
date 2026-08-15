import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { doctor, doctorMarkdown } from "../src/doctor.js";
import { cleanup, temporaryPaths } from "./helpers.js";
import { install } from "../src/installer.js";

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

  it("warns when a provider binary wins PATH resolution ahead of its shim", () => {
    const paths = temporaryPaths();
    install(paths, { noShellConfig: true, noAgent: true, executable: "/opt/tokenpilot/dist/cli.js", nodeExecutable: "/usr/local/bin/node" });
    const originalBin = path.join(paths.userHome, "original-bin");
    fs.mkdirSync(originalBin, { recursive: true, mode: 0o700 });
    for (const provider of ["claude", "grok"]) {
      fs.writeFileSync(path.join(originalBin, provider), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    const report = doctor(paths, { platform: "linux", nodeVersion: "22.5.0", pathValue: `${originalBin}${path.delimiter}${paths.shimDir}` });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Wrappers and PATH", status: "warning", detail: expect.stringContaining("claude, grok") })
    ]));
    cleanup(paths);
  });
});
