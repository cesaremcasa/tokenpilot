import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPendingRuns } from "../src/collector.js";
import { TelemetryDatabase } from "../src/database.js";
import { ensureConfig, writeConfig } from "../src/config.js";
import { runProvider } from "../src/launcher.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("local launcher and collector", () => {
  async function withProviderPath<T>(providerPath: string, action: () => Promise<T>): Promise<T> {
    const originalPath = process.env.PATH;
    process.env.PATH = providerPath;
    try {
      return await action();
    } finally {
      process.env.PATH = originalPath;
    }
  }

  function writeFakeCodex(paths: ReturnType<typeof temporaryPaths>, contents: string): string {
    const originalBin = path.join(paths.userHome, "original-bin");
    const original = path.join(originalBin, "codex");
    fs.mkdirSync(originalBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(original, contents, { mode: 0o700 });
    return originalBin;
  }

  function writeFakeClaude(paths: ReturnType<typeof temporaryPaths>, contents: string): string {
    const originalBin = path.join(paths.userHome, "original-claude-bin");
    const original = path.join(originalBin, "claude");
    fs.mkdirSync(originalBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(original, contents, { mode: 0o700 });
    return originalBin;
  }

  function writeFakeGrok(paths: ReturnType<typeof temporaryPaths>, contents: string): string {
    const originalBin = path.join(paths.userHome, "original-grok-bin");
    const original = path.join(originalBin, "grok");
    fs.mkdirSync(originalBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(original, contents, { mode: 0o700 });
    return originalBin;
  }

  it("records an envelope but never imports ambient provider telemetry", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'fake-codex 1.0\\n'; fi\nexit 0\n");

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["run"], paths))).toBe(0);
    const before = new TelemetryDatabase(paths);
    const pending = before.getPendingRuns();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ provider: "codex", mode: "observe", collectionState: "pending" });
    const runId = pending[0].id;
    before.close();

    const sessionDir = path.join(paths.userHome, ".codex", "sessions", "test");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), '{"payload":{"info":{"last_token_usage":{"input_tokens":7,"cached_input_tokens":19,"output_tokens":4}}},"message":"do not store this"}\n');

    expect(collectPendingRuns(paths)).toEqual({ collected: 0, unavailable: 1 });
    const after = new TelemetryDatabase(paths);
    expect(after.getRun(runId)).toMatchObject({ collectionState: "unavailable" });
    expect(after.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ inputNew: 0, inputCached: 0, output: 0 });
    after.close();
    cleanup(paths);
  });

  it("injects a verified treatment and records its policy without retaining arguments", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo '--config'; exit 0; fi\nif [ \"$1\" = \"--version\" ]; then echo 'fake-codex 1.0'; exit 0; fi\nexit 0\n");
    const config = ensureConfig(paths);
    config.defaultMode = "balanced";
    writeConfig(paths, config);
    const allocator = new TelemetryDatabase(paths);
    expect(allocator.allocateBalancedMode("codex", () => 0.9)).toBe("observe");
    allocator.close();

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["exec", "test"], paths))).toBe(0);
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

  it("records only Codex exec's provider-published final numeric total", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'fake-codex 1.0'; exit 0; fi\nprintf 'response that must not persist\\ntokens used\\n7,675\\n'\nexit 0\n");

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["exec", "test"], paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    const run = database.getPendingRuns();
    expect(run).toHaveLength(0);
    const aggregate = database.aggregateSince(new Date(Date.now() - 60_000).toISOString());
    expect(aggregate[0]).toMatchObject({ provider: "codex", reportedTotal: 7675, inputNew: 0, output: 0 });
    database.close();
    cleanup(paths);
  });

  it("records only the numeric usage object from explicit Grok JSON single-turn output", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeGrok(paths, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'grok 1.0'; exit 0; fi\nprintf '{\\n  \"text\": \"must not persist\",\\n  \"usage\": {\\n    \"input_tokens\": 12,\\n    \"cache_read_input_tokens\": 34,\\n    \"cache_creation_input_tokens\": 0,\\n    \"output_tokens\": 5,\\n    \"reasoning_tokens\": 6,\\n    \"total_tokens\": 57\\n  }\\n}\\n'\nexit 0\n");

    expect(await withProviderPath(originalBin, () => runProvider("grok", ["--output-format", "json", "--single", "test"], paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    expect(database.getPendingRuns()).toHaveLength(0);
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ provider: "grok", inputNew: 12, inputCached: 34, output: 5, reasoning: 6, reportedTotal: 57 });
    database.close();
    cleanup(paths);
  });

  it("scopes Claude to authenticated local metrics with content signals disabled", async () => {
    const paths = temporaryPaths();
    const environmentFile = path.join(paths.userHome, "claude-environment");
    const originalBin = writeFakeClaude(paths, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'claude 2.1.300'; exit 0; fi
if [ "$1" = "--help" ]; then exit 0; fi
printf '%s|%s|%s|%s|%s|%s|%s|%s' "$CLAUDE_CODE_ENABLE_TELEMETRY" "$OTEL_METRICS_EXPORTER" "$OTEL_LOGS_EXPORTER" "$OTEL_TRACES_EXPORTER" "$OTEL_LOG_USER_PROMPTS" "$OTEL_METRICS_INCLUDE_ACCOUNT_UUID" "$OTEL_EXPORTER_OTLP_METRICS_PROTOCOL" "$OTEL_METRIC_EXPORT_INTERVAL" > '${environmentFile}'
exit 0
`);

    expect(await withProviderPath(originalBin, () => runProvider("claude", ["run"], paths))).toBe(0);
    expect(fs.readFileSync(environmentFile, "utf8")).toBe("1|otlp|none|none|0|false|http/json|1000");
    const database = new TelemetryDatabase(paths);
    expect(database.getPendingRuns()).toHaveLength(0);
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ provider: "claude", inputNew: 0 });
    database.close();
    cleanup(paths);
  });

  it("launches the original CLI exactly once when optional state is invalid", async () => {
    const paths = temporaryPaths();
    const invocations = path.join(paths.userHome, "invocations");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh\nprintf x >> '${invocations}'\nexit 0\n`);
    fs.mkdirSync(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.configFile, "{}\n", { mode: 0o600 });

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["run"], paths))).toBe(0);
    expect(fs.readFileSync(invocations, "utf8")).toBe("x");
    cleanup(paths);
  });

  it("does not initialize TokenPilot state for a passthrough command", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nexit 0\n");

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["--version"], paths))).toBe(0);
    expect(fs.existsSync(paths.configFile)).toBe(false);
    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    cleanup(paths);
  });

  it("records a local session automatically without a terminal environment flag", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nexit 0\n");

    const originalPersonalSession = process.env.TOKENPILOT_PERSONAL_SESSION;
    delete process.env.TOKENPILOT_PERSONAL_SESSION;
    try {
      expect(await withProviderPath(originalBin, () => runProvider("codex", ["run"], paths))).toBe(0);
      const database = new TelemetryDatabase(paths);
      expect(database.getPendingRuns()).toHaveLength(1);
      database.close();
    } finally {
      if (originalPersonalSession === undefined) delete process.env.TOKENPILOT_PERSONAL_SESSION;
      else process.env.TOKENPILOT_PERSONAL_SESSION = originalPersonalSession;
    }
    cleanup(paths);
  });

  it("does not persist arbitrary provider version output", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'secret-project-path /private/work'; fi\nexit 0\n");

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["run"], paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    expect(database.getPendingRuns()[0]?.cliVersion).toBeNull();
    database.close();
    cleanup(paths);
  });

  it("uses a minimal trusted PATH for env-based provider interpreters", async () => {
    const paths = temporaryPaths();
    const providerBin = path.join(paths.userHome, "provider-bin");
    const hostileBin = path.join(paths.userHome, "hostile-bin");
    fs.mkdirSync(providerBin, { recursive: true, mode: 0o700 });
    fs.mkdirSync(hostileBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(providerBin, "codex"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(path.join(hostileBin, "sh"), "#!/bin/sh\nexit 88\n", { mode: 0o700 });

    expect(await withProviderPath(`${hostileBin}${path.delimiter}${providerBin}`, () => runProvider("codex", ["run"], paths))).toBe(0);
    cleanup(paths);
  });
});
