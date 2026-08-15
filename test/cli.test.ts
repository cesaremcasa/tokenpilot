import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isVersionCommand, TOKENPILOT_VERSION } from "../src/version.js";

describe("TokenPilot CLI identity", () => {
  it("keeps the runtime version synchronized with package metadata", () => {
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(TOKENPILOT_VERSION).toBe(packageMetadata.version);
  });

  it("recognizes every documented version alias", () => {
    expect(["--version", "-V", "version"].every(isVersionCommand)).toBe(true);
    expect(isVersionCommand("--help")).toBe(false);
  });

  it("prints its installed version through the real CLI entrypoint", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      // The installed command shim always sets this before loading cli.js.
      // Match the production entrypoint so Node's experimental SQLite warning
      // cannot make a successful identity command look like an application error.
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`tokenpilot ${TOKENPILOT_VERSION}\n`);
    expect(result.stderr).toBe("");
  });
});
