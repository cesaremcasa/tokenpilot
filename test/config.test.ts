import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureConfig, selectMode } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("mode selection", () => {
  it("uses observe by default and bypasses completely when requested", () => {
    expect(selectMode(DEFAULT_CONFIG, false)).toBe("observe");
    expect(selectMode(DEFAULT_CONFIG, true)).toBe("off");
  });

  it("randomizes balanced sessions deterministically when provided a random source", () => {
    const balanced = { ...DEFAULT_CONFIG, defaultMode: "balanced" as const, balancedSamplingRate: 0.5 };
    expect(selectMode(balanced, false, () => 0.2)).toBe("balanced");
    expect(selectMode(balanced, false, () => 0.9)).toBe("observe");
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
