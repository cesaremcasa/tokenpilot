import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureConfig } from "../src/config.js";
import { TelemetryDatabase } from "../src/database.js";
import { getPaths } from "../src/paths.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("configuration and balanced allocation", () => {
  it("persists a balanced 50/50 sequence independently for each provider", () => {
    const paths = temporaryPaths();
    const database = new TelemetryDatabase(paths);
    expect(database.allocateBalancedMode("codex", () => 0.2)).toBe("balanced");
    expect(database.allocateBalancedMode("codex", () => 0.9)).toBe("observe");
    expect(database.allocateBalancedMode("claude", () => 0.9)).toBe("observe");
    database.close();

    const reopened = new TelemetryDatabase(paths);
    expect(reopened.allocateBalancedMode("codex", () => 0.9)).toBe("balanced");
    expect(reopened.allocateBalancedMode("claude", () => 0.2)).toBe("balanced");
    reopened.close();
    cleanup(paths);
  });

  it("does not honor mutable environment state roots in the installed CLI", () => {
    const redirected = path.join(os.tmpdir(), "tokenpilot-redirected-state");
    const originalHome = process.env.HOME;
    let production: ReturnType<typeof getPaths>;
    try {
      process.env.HOME = redirected;
      production = getPaths({ HOME: redirected, TOKENPILOT_HOME: redirected, TOKENPILOT_CONFIG_HOME: redirected, TOKENPILOT_DATA_HOME: redirected });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
    expect(production.home).toBe(path.join(os.userInfo().homedir, ".tokenpilot"));
    expect(production.configDir).toBe(path.join(os.userInfo().homedir, ".config", "tokenpilot"));

    const testOnly = getPaths({ HOME: redirected, TOKENPILOT_HOME: redirected, TOKENPILOT_CONFIG_HOME: redirected, TOKENPILOT_DATA_HOME: redirected }, { allowEnvironmentOverrides: true });
    expect(testOnly.home).toBe(redirected);
    expect(testOnly.userHome).toBe(redirected);
  });

  it("keeps Linux configuration and telemetry below TokenPilot-owned state", () => {
    const home = path.join(os.tmpdir(), "tokenpilot-linux-user");
    const linux = getPaths({ HOME: home }, { allowEnvironmentOverrides: true, platform: "linux" });
    expect(linux.home).toBe(path.join(home, ".tokenpilot"));
    expect(linux.configDir).toBe(path.join(home, ".tokenpilot", "config"));
    expect(linux.dataDir).toBe(path.join(home, ".tokenpilot", "data"));
  });

  it("drops legacy executable paths and rejects invalid modes", () => {
    const paths = temporaryPaths();
    fs.mkdirSync(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.configFile, JSON.stringify({ ...DEFAULT_CONFIG, providers: { codex: { originalPath: "/tmp/evil" } } }), { mode: 0o600 });
    expect(ensureConfig(paths)).toEqual(DEFAULT_CONFIG);
    fs.writeFileSync(paths.configFile, JSON.stringify({ ...DEFAULT_CONFIG, defaultMode: "shell-injection" }), { mode: 0o600 });
    expect(() => ensureConfig(paths)).toThrow("Unsupported TokenPilot configuration");
    cleanup(paths);
  });
});
