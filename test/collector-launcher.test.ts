import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPendingRuns } from "../src/collector.js";
import { TelemetryDatabase } from "../src/database.js";
import { ensureConfig, writeConfig } from "../src/config.js";
import { runProvider } from "../src/launcher.js";
import { CLAUDE_CORE_TOOLS, CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION, GROK_TOKEN_EFFICIENCY_INSTRUCTION, TOKEN_EFFICIENCY_INSTRUCTION } from "../src/optimization.js";
import { buildReport, reportMarkdown } from "../src/report.js";
import { cleanup, grokOtlpFixture, temporaryPaths } from "./helpers.js";

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

  function writeFakeKimi(paths: ReturnType<typeof temporaryPaths>, contents: string): string {
    const originalBin = path.join(paths.userHome, "original-kimi-bin");
    const original = path.join(originalBin, "kimi");
    fs.mkdirSync(originalBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(original, contents, { mode: 0o700 });
    return originalBin;
  }

  it("records an envelope but never imports ambient provider telemetry", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'fake-codex 1.0\\n'; fi\nexit 0\n");
    const config = ensureConfig(paths);
    config.defaultMode = "observe";
    writeConfig(paths, config);

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["run"], paths))).toBe(0);
    const before = new TelemetryDatabase(paths);
    const recorded = before.recentRunsSince(new Date(0).toISOString());
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "codex", mode: "observe", collectionState: "unavailable" });
    const runId = recorded[0].id;
    before.close();

    const sessionDir = path.join(paths.userHome, ".codex", "sessions", "test");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), '{"payload":{"info":{"last_token_usage":{"input_tokens":7,"cached_input_tokens":19,"output_tokens":4}}},"message":"do not store this"}\n');

    expect(collectPendingRuns(paths)).toEqual({ collected: 0, unavailable: 0 });
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

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["exec", "super-secret-command-argument"], paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "codex",
      mode: "balanced",
      optimizationApplied: true,
      optimizationProfile: "codex-balanced-v2",
      collectionState: "unavailable"
    });
    database.close();
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    const markdown = reportMarkdown(buildReport(paths, 7));
    for (const forbidden of ["super-secret-command-argument", TOKEN_EFFICIENCY_INSTRUCTION]) {
      expect(rawDatabase).not.toContain(forbidden);
      expect(markdown).not.toContain(forbidden);
    }
    cleanup(paths);
  });

  it("always injects the Grok reduction policy in reduce mode", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "grok-reduce-arguments");
    const originalBin = writeFakeGrok(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'grok 1.0.4'; exit 0 ;;
  *" --help "*) echo '--reasoning-effort <effort> --verbatim --no-subagents --no-memory --disable-web-search --no-plan --system-prompt-override <prompt> --tools <tools>'; exit 0 ;;
esac
printf '%s\n' "$@" > '${observedArguments}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);
    const allocator = new TelemetryDatabase(paths);
    expect(allocator.allocateBalancedMode("grok", () => 0.9)).toBe("observe");
    allocator.close();

    expect(await withProviderPath(originalBin, () => runProvider("grok", [], paths))).toBe(0);
    const tuiArguments = fs.readFileSync(observedArguments, "utf8");
    expect(tuiArguments).toContain("--verbatim");
    expect(tuiArguments).toContain("--no-subagents");
    expect(tuiArguments).toContain("--no-memory");
    expect(tuiArguments).toContain("--disable-web-search");
    expect(tuiArguments).toContain("--no-plan");
    expect(tuiArguments).toContain("--system-prompt-override");
    expect(tuiArguments).not.toContain("--tools");
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "grok",
      mode: "reduce",
      optimizationApplied: true,
      optimizationProfile: "grok-balanced-v6"
    });
    database.close();
    cleanup(paths);
  });

  it("injects the complete Grok v6 policy without retaining its fixed rule", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "grok-arguments");
    const originalBin = writeFakeGrok(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'grok 1.0.4'; exit 0 ;;
  *" --help "*) echo '--reasoning-effort <effort> --verbatim --no-subagents --no-memory --disable-web-search --no-plan --system-prompt-override <prompt> --tools <tools>'; exit 0 ;;
esac
printf '%s\n' "$@" > '${observedArguments}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "balanced";
    writeConfig(paths, config);
    const allocator = new TelemetryDatabase(paths);
    expect(allocator.allocateBalancedMode("grok", () => 0.9)).toBe("observe");
    allocator.close();

    expect(await withProviderPath(originalBin, () => runProvider("grok", ["--single", "private-task"], paths))).toBe(0);
    const argumentsText = fs.readFileSync(observedArguments, "utf8");
    expect(argumentsText).toContain("low");
    expect(argumentsText).toContain("--verbatim");
    expect(argumentsText).toContain("--no-subagents");
    expect(argumentsText).toContain("--no-memory");
    expect(argumentsText).toContain("--disable-web-search");
    expect(argumentsText).toContain("--no-plan");
    expect(argumentsText).toContain("--system-prompt-override");
    expect(argumentsText).toContain("--tools");
    expect(argumentsText).toContain("run_terminal_cmd");
    expect(argumentsText).toContain(GROK_TOKEN_EFFICIENCY_INSTRUCTION);

    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "grok",
      mode: "balanced",
      optimizationApplied: true,
      optimizationProfile: "grok-balanced-v6"
    });
    database.close();
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    const markdown = reportMarkdown(buildReport(paths, 7));
    for (const forbidden of ["private-task", GROK_TOKEN_EFFICIENCY_INSTRUCTION]) {
      expect(rawDatabase).not.toContain(forbidden);
      expect(markdown).not.toContain(forbidden);
    }
    cleanup(paths);
  });

  it("deduplicates explicit Grok treatment flags in the real v0.4.16 reproduction", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "grok-deduplicated-arguments.json");
    const originalBin = writeFakeGrok(paths, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const flags = ["--no-subagents", "--disable-web-search", "--no-memory"];
if (args.includes("--version")) { console.log("grok 1.0.4"); process.exit(0); }
if (args.includes("--help")) { console.log("--reasoning-effort <effort> --verbatim --no-subagents --no-memory --disable-web-search --no-plan --system-prompt-override <prompt> --tools <tools>"); process.exit(0); }
const duplicate = flags.find((flag) => args.filter((argument) => argument === flag).length > 1);
if (duplicate) { console.error("argument cannot be used multiple times: " + duplicate); process.exit(64); }
fs.writeFileSync("${observedArguments}", JSON.stringify(args));
process.exit(0);
`);
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);
    const explicit = ["--single", "Return exactly TOKENPILOT_CANARY_OK.", "--max-turns", "1", "--no-subagents", "--disable-web-search", "--no-memory", "--output-format", "json"];

    expect(await withProviderPath(originalBin, () => runProvider("grok", explicit, paths))).toBe(0);
    const observed = JSON.parse(fs.readFileSync(observedArguments, "utf8"));
    expect(observed.slice(-explicit.length)).toEqual(explicit);
    for (const flag of ["--no-subagents", "--disable-web-search", "--no-memory"]) {
      expect(observed.filter((argument) => argument === flag)).toHaveLength(1);
    }
    cleanup(paths);
  });

  it("fails open before database creation when an explicit treatment value conflicts", async () => {
    const paths = temporaryPaths();
    const invocations = path.join(paths.userHome, "grok-conflict-invocations");
    const originalBin = writeFakeGrok(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'grok 1.0.4'; exit 0 ;;
  *" --help "*) echo '--reasoning-effort <effort> --verbatim --no-subagents --no-memory --disable-web-search --no-plan --system-prompt-override <prompt> --tools <tools>'; exit 0 ;;
esac
printf x >> '${invocations}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);

    expect(await withProviderPath(originalBin, () => runProvider("grok", ["--reasoning-effort", "high", "--single", "task"], paths))).toBe(0);
    expect(fs.readFileSync(invocations, "utf8")).toBe("x");
    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    cleanup(paths);
  });

  it("injects the complete Claude v7 latency policy without retaining its fixed instruction", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "claude-arguments");
    const originalBin = writeFakeClaude(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'claude 2.1.233'; exit 0 ;;
  *" --help "*) echo '--effort <level> --tools <tools> --append-system-prompt <prompt> --no-chrome --exclude-dynamic-system-prompt-sections'; exit 0 ;;
esac
printf '%s\n' "$@" > '${observedArguments}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "balanced";
    writeConfig(paths, config);
    const allocator = new TelemetryDatabase(paths);
    expect(allocator.allocateBalancedMode("claude", () => 0.9)).toBe("observe");
    allocator.close();

    expect(await withProviderPath(originalBin, () => runProvider("claude", ["-p", "private-task"], paths))).toBe(0);
    const argumentsText = fs.readFileSync(observedArguments, "utf8");
    expect(argumentsText).toContain("low");
    expect(argumentsText).toContain(CLAUDE_CORE_TOOLS);
    expect(argumentsText).toContain("--no-chrome");
    expect(argumentsText).toContain("--exclude-dynamic-system-prompt-sections");
    expect(argumentsText).toContain(CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION);

    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "claude",
      mode: "balanced",
      optimizationApplied: true,
      optimizationProfile: "claude-balanced-v7"
    });
    database.close();
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    const markdown = reportMarkdown(buildReport(paths, 7));
    for (const forbidden of ["private-task", CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION]) {
      expect(rawDatabase).not.toContain(forbidden);
      expect(markdown).not.toContain(forbidden);
    }
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
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    const markdown = reportMarkdown(buildReport(paths, 7));
    for (const forbidden of ["response that must not persist", "super-secret-command-argument", "fake-codex"]) {
      expect(rawDatabase).not.toContain(forbidden);
      expect(markdown).not.toContain(forbidden);
    }
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

  it("measures a normal Grok TTY/TUI run through its session-scoped External OTEL stream", async () => {
    const paths = temporaryPaths();
    const payload = grokOtlpFixture({ input: 76, cache_read: 55, output: 8, reasoning: 13 }).toString("base64");
    const originalBin = writeFakeGrok(paths, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("grok 1.0.3"); process.exit(0); }
const endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const header = process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS?.split("=")[1];
if (!endpoint || !header || process.env.OTEL_LOG_USER_PROMPTS !== "0" || process.env.OTEL_LOG_TOOL_DETAILS !== "0") process.exit(2);
const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-protobuf", "x-tokenpilot-metrics": header }, body: Buffer.from("${payload}", "base64") });
process.exit(response.ok ? 0 : 3);
`);
    const config = ensureConfig(paths);
    config.defaultMode = "observe";
    writeConfig(paths, config);

    expect(await withProviderPath(originalBin, () => runProvider("grok", [], paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({ provider: "grok", collectionState: "collected" });
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({
      provider: "grok", inputNew: 21, inputCached: 55, cacheCreated: 0, output: 8, reasoning: 13
    });
    database.close();
    expect(fs.readFileSync(paths.databaseFile).toString("latin1")).not.toContain("person@example.test");
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

  it("launches Kimi unchanged once without opening a local session bridge", async () => {
    const paths = temporaryPaths();
    const invocations = path.join(paths.userHome, "kimi-task-invocations");
    const originalBin = writeFakeKimi(paths, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'kimi 0.36.1'; exit 0; fi
printf '%s ' "$@" >> '${invocations}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "observe";
    writeConfig(paths, config);

    expect(await withProviderPath(originalBin, () => runProvider("kimi", ["-p", "private-kimi-task"], paths))).toBe(0);
    expect(fs.readFileSync(invocations, "utf8")).toBe("-p private-kimi-task ");
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())).toEqual([
      expect.objectContaining({ provider: "kimi", collectionState: "unavailable", collectionReason: "kimi-envelope" })
    ]);
    database.close();
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    expect(rawDatabase).not.toContain("private-kimi-task");
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
      expect(database.getPendingRuns()).toHaveLength(0);
      expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({ collectionState: "unavailable" });
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
    expect(database.recentRunsSince(new Date(0).toISOString())[0]?.cliVersion).toBeNull();
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

  it("does not pass TokenPilot's Node warning suppression to the provider", async () => {
    const paths = temporaryPaths();
    const observed = path.join(paths.userHome, "provider-environment");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh\nprintf '%s' "\${NODE_NO_WARNINGS-unset}" > '${observed}'\nexit 0\n`);
    const prior = process.env.NODE_NO_WARNINGS;
    process.env.NODE_NO_WARNINGS = "1";
    try {
      expect(await withProviderPath(originalBin, () => runProvider("codex", ["run"], paths))).toBe(0);
      expect(fs.readFileSync(observed, "utf8")).toBe("unset");
    } finally {
      if (prior === undefined) delete process.env.NODE_NO_WARNINGS;
      else process.env.NODE_NO_WARNINGS = prior;
    }
    cleanup(paths);
  });

  it("removes its process signal handlers after the wrapped CLI exits", async () => {
    const paths = temporaryPaths();
    const originalBin = writeFakeCodex(paths, "#!/bin/sh\nexit 0\n");
    const interrupts = process.listenerCount("SIGINT");
    const terminations = process.listenerCount("SIGTERM");
    expect(await withProviderPath(originalBin, () => runProvider("codex", ["run"], paths))).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(interrupts);
    expect(process.listenerCount("SIGTERM")).toBe(terminations);
    cleanup(paths);
  });
});
