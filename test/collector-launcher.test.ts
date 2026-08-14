import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPendingRuns } from "../src/collector.js";
import { TelemetryDatabase } from "../src/database.js";
import { ensureConfig, rememberProviderPath, writeConfig } from "../src/config.js";
import { runProvider } from "../src/launcher.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("local launcher and collector", () => {
  it("records a normal CLI envelope, then collects only numeric session counters", async () => {
    const paths = temporaryPaths();
    const originalBin = path.join(paths.userHome, "original-bin");
    const original = path.join(originalBin, "codex");
    fs.mkdirSync(originalBin, { recursive: true });
    fs.writeFileSync(original, "#!/bin/sh\nprintf 'fake-codex 1.0\\n'\nexit 0\n", { mode: 0o700 });
    rememberProviderPath(paths, "codex", original);

    expect(await runProvider("codex", ["run"], paths)).toBe(0);
    const before = new TelemetryDatabase(paths);
    const pending = before.getPendingRuns();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ provider: "codex", mode: "observe", collectionState: "pending" });
    const runId = pending[0].id;
    before.close();

    const sessionDir = path.join(paths.userHome, ".codex", "sessions", "test");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), '{"payload":{"info":{"last_token_usage":{"input_tokens":7,"cached_input_tokens":19,"output_tokens":4}}},"message":"do not store this"}\n');

    expect(collectPendingRuns(paths, paths.userHome)).toEqual({ collected: 1, unavailable: 0 });
    const after = new TelemetryDatabase(paths);
    expect(after.getRun(runId)).toMatchObject({ collectionState: "collected" });
    expect(after.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ inputNew: 7, inputCached: 19, output: 4 });
    after.close();
    cleanup(paths);
  });

  it("injects a verified treatment and records its policy without retaining arguments", async () => {
    const paths = temporaryPaths();
    const originalBin = path.join(paths.userHome, "original-bin");
    const original = path.join(originalBin, "codex");
    fs.mkdirSync(originalBin, { recursive: true });
    fs.writeFileSync(original, "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo '--config'; exit 0; fi\nprintf 'fake-codex %s\\n' \"$*\"\nexit 0\n", { mode: 0o700 });
    rememberProviderPath(paths, "codex", original);
    const config = ensureConfig(paths);
    config.defaultMode = "balanced";
    config.balancedSamplingRate = 1;
    writeConfig(paths, config);

    expect(await runProvider("codex", ["exec", "test"], paths)).toBe(0);
    const database = new TelemetryDatabase(paths);
    expect(database.getPendingRuns()[0]).toMatchObject({
      provider: "codex",
      mode: "balanced",
      optimizationApplied: true,
      optimizationProfile: "codex-balanced-v1"
    });
    database.close();
    cleanup(paths);
  });
});
