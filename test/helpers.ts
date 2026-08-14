import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPaths } from "../src/paths.js";

export function temporaryPaths(): ReturnType<typeof getPaths> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-test-"));
  return getPaths({
    HOME: path.join(root, "home"),
    TOKENPILOT_HOME: path.join(root, "tokenpilot"),
    TOKENPILOT_CONFIG_HOME: path.join(root, "config"),
    TOKENPILOT_DATA_HOME: path.join(root, "data")
  });
}

export function cleanup(paths: ReturnType<typeof getPaths>): void {
  fs.rmSync(path.dirname(paths.home), { recursive: true, force: true });
}
