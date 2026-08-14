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
