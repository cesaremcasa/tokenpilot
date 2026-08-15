import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TOKENPILOT_VERSION } from "../src/version.js";

describe("TokenPilot CLI identity", () => {
  it("keeps the runtime version synchronized with package metadata", () => {
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(TOKENPILOT_VERSION).toBe(packageMetadata.version);
  });

  it.each(["--version", "-V", "version"])("prints its installed version for %s", (argument) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", argument], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`tokenpilot ${TOKENPILOT_VERSION}\n`);
    expect(result.stderr).toBe("");
  });
});
