import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPendingRuns } from "../src/collector.js";
import { TelemetryDatabase } from "../src/database.js";
import { ensureConfig, writeConfig } from "../src/config.js";
import { runProvider } from "../src/launcher.js";
import { CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION, CODEX_TOKEN_EFFICIENCY_INSTRUCTION, CODEX_V10_TOKEN_EFFICIENCY_INSTRUCTION, GROK_TOKEN_EFFICIENCY_INSTRUCTION, TOKEN_EFFICIENCY_INSTRUCTION } from "../src/optimization.js";
import { buildReport, reportMarkdown, reportSummaryMarkdown } from "../src/report.js";
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

  function writeFakeCodex(
    paths: ReturnType<typeof temporaryPaths>,
    contents: string,
    appServer: { skills?: Array<{ name: string; path: string; enabled: boolean }>; errors?: string[]; observedCwdFile?: string } = {}
  ): string {
    const originalBin = path.join(paths.userHome, "original-bin");
    const original = path.join(originalBin, "codex");
    const provider = path.join(originalBin, "codex-original");
    const server = path.join(originalBin, "codex-app-server.cjs");
    fs.mkdirSync(originalBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(provider, contents, { mode: 0o700 });
    fs.writeFileSync(server, `const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { protocolVersion: "2025-03-26" } }) + "\\n");
  if (request.method === "skills/list") {
    ${appServer.observedCwdFile ? `fs.writeFileSync(${JSON.stringify(appServer.observedCwdFile)}, JSON.stringify({ processCwd: process.cwd(), cwds: request.params.cwds }));` : ""}
    process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{ errors: ${JSON.stringify(appServer.errors ?? [])}, skills: ${JSON.stringify(appServer.skills ?? [])} }] } }) + "\\n");
  }
});
`, { mode: 0o600 });
    fs.writeFileSync(original, `#!/bin/sh
if [ "$1" = "app-server" ]; then exec '${process.execPath}' '${server}'; fi
exec '${provider}' "$@"
`, { mode: 0o700 });
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

  it("bypasses treatment and telemetry through the process override or off mode", async () => {
    const paths = temporaryPaths();
    const invocations = path.join(paths.userHome, "bypass-invocations");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
if [ "$1" = "--version" ] || [ "$1" = "--help" ]; then exit 0; fi
printf '%s\\n' "$*" >> '${invocations}'
exit 0
`);

    const originalBypass = process.env.TOKENPILOT_BYPASS;
    process.env.TOKENPILOT_BYPASS = "1";
    try {
      expect(await withProviderPath(originalBin, () => runProvider("codex", ["run", "bypassed-task"], paths))).toBe(0);
    } finally {
      if (originalBypass === undefined) delete process.env.TOKENPILOT_BYPASS;
      else process.env.TOKENPILOT_BYPASS = originalBypass;
    }
    expect(fs.existsSync(paths.configFile)).toBe(false);
    expect(fs.existsSync(paths.databaseFile)).toBe(false);

    const config = ensureConfig(paths);
    config.defaultMode = "off";
    writeConfig(paths, config);
    expect(await withProviderPath(originalBin, () => runProvider("codex", ["run", "off-task"], paths))).toBe(0);
    expect(fs.readFileSync(invocations, "utf8")).toBe("run bypassed-task\nrun off-task\n");
    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    cleanup(paths);
  });

  it("keeps deep mode argument-transparent while retaining measurement", async () => {
    const paths = temporaryPaths();
    const invocations = path.join(paths.userHome, "deep-invocations");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'fake-codex 1.0'; exit 0; fi
if [ "$1" = "--help" ]; then exit 0; fi
printf '%s\\n' "$*" > '${invocations}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "deep";
    writeConfig(paths, config);

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["run", "deep-task"], paths))).toBe(0);
    expect(fs.readFileSync(invocations, "utf8")).toBe("run deep-task\n");
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "codex",
      mode: "deep",
      optimizationApplied: false,
      collectionState: "unavailable"
    });
    database.close();
    expect(fs.readFileSync(paths.databaseFile).toString("latin1")).not.toContain("deep-task");
    cleanup(paths);
  });

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
    expect(after.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ inputNew: null, inputCached: null, output: null });
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

    expect(await withProviderPath(originalBin, () => runProvider("codex", ["exec", "--model", "gpt-6-astra", "super-secret-command-argument"], paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "codex",
      mode: "balanced",
      optimizationApplied: true,
      optimizationProfile: "codex-balanced-v23",
      collectionState: "unavailable"
    });
    database.close();
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    const markdown = reportMarkdown(buildReport(paths, 7));
    for (const forbidden of ["super-secret-command-argument", "gpt-6-astra", TOKEN_EFFICIENCY_INSTRUCTION, CODEX_TOKEN_EFFICIENCY_INSTRUCTION]) {
      expect(rawDatabase).not.toContain(forbidden);
      expect(markdown).not.toContain(forbidden);
    }
    cleanup(paths);
  });

  it("records a balanced observe arm with its comparison profile but no treatment profile", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "codex-observe-arguments");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--config'; exit 0; fi
if [ "$1" = "--version" ]; then echo 'fake-codex 1.0'; exit 0; fi
printf '%s\n' "$@" > '${observedArguments}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "balanced";
    writeConfig(paths, config);
    const allocator = new TelemetryDatabase(paths);
    expect(allocator.allocateBalancedMode("codex", () => 0.1)).toBe("balanced");
    allocator.close();

    const explicit = ["exec", "--model", "gpt-5.5", "observe-user"];
    expect(await withProviderPath(originalBin, () => runProvider("codex", explicit, paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    const run = database.recentRunsSince(new Date(0).toISOString())[0];
    expect(run).toMatchObject({ mode: "observe", optimizationApplied: false, comparisonProfile: "codex-balanced-v18" });
    expect(run?.optimizationProfile).toBeNull();
    database.close();
    const observed = fs.readFileSync(observedArguments, "utf8").trim().split("\n");
    expect(observed.slice(-explicit.length)).toEqual(explicit);
    expect(observed.join(" ")).not.toContain("model_reasoning_effort");
    expect(observed.join(" ")).not.toContain(TOKEN_EFFICIENCY_INSTRUCTION);
    cleanup(paths);
  });

  it("applies the verified Codex policy to an explicit gpt-5.5 invocation", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "codex-gpt55-arguments");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '-c, --config <key=value> --model <model>'; exit 0; fi
if [ "$1" = "--version" ]; then echo 'fake-codex 1.0'; exit 0; fi
printf '%s\\n' "$@" > '${observedArguments}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);

    const explicit = ["exec", "--model", "gpt-5.5", "--sandbox", "workspace-write", "task"];
    expect(await withProviderPath(originalBin, () => runProvider("codex", explicit, paths))).toBe(0);

    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      mode: "reduce",
      optimizationApplied: true,
      optimizationProfile: "codex-balanced-v18",
      comparisonProfile: "codex-balanced-v18"
    });
    database.close();
    const launchedArguments = fs.readFileSync(observedArguments, "utf8").trim().split("\n");
    expect(launchedArguments.slice(-explicit.length)).toEqual(explicit);
    expect(launchedArguments.join(" ")).not.toContain("model_auto_compact_token_limit");
    expect(launchedArguments.join(" ")).not.toContain("--model gpt-6");
    cleanup(paths);
  });

  it.each([
    { selection: "config-only", args: ["exec", "--config", 'model="gpt-5.5"', "config-selected-task"] },
    { selection: "profile-only", args: ["exec", "--profile", "gpt55", "profile-selected-task"] },
    { selection: "ambiguous", args: ["exec", "--model", "gpt-5.5", "--model", "gpt-6-luna", "ambiguous-task"] }
  ])("measures Codex without a treatment for $selection model selection", async ({ args }) => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "codex-unselected-model-arguments");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--config'; exit 0; fi
if [ "$1" = "--version" ]; then echo 'fake-codex 1.0'; exit 0; fi
printf '%s\\n' "$*" >> '${observedArguments}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);

    expect(await withProviderPath(originalBin, () => runProvider("codex", args, paths))).toBe(0);

    const database = new TelemetryDatabase(paths);
    const runs = database.recentRunsSince(new Date(0).toISOString());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      provider: "codex",
      mode: "reduce",
      optimizationApplied: false,
      optimizationProfile: null,
      comparisonProfile: null
    });
    database.close();
    const observed = fs.readFileSync(observedArguments, "utf8").trim().split("\n");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain(args.join(" "));
    expect(observed[0]).not.toContain("developer_instructions");
    expect(observed[0]).not.toContain("model_auto_compact_token_limit");
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    expect(rawDatabase).not.toContain("gpt-5.5");
    expect(rawDatabase).not.toContain("gpt-6-luna");
    expect(rawDatabase).not.toContain("config-selected-task");
    cleanup(paths);
  }, 15_000);

  it("always injects the Grok reduction policy in reduce mode", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "grok-reduce-arguments");
    const originalBin = writeFakeGrok(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'grok 1.0.46'; exit 0 ;;
  *" --help "*) echo '--reasoning-effort <effort> --verbatim --rules <rules> --system-prompt-override <prompt> --tools <tools> --no-subagents --disable-web-search --no-plan'; exit 0 ;;
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
    for (const flag of ["--no-subagents", "--no-memory", "--disable-web-search", "--no-plan", "--tools", "--system-prompt-override"]) {
      expect(tuiArguments).not.toContain(flag);
    }
    expect(tuiArguments).toContain("--rules");
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "grok",
      mode: "reduce",
      optimizationApplied: true,
      optimizationProfile: "grok-balanced-v8"
    });
    database.close();
    cleanup(paths);
  });

  it("injects Grok v7 through an appended rule while preserving native capabilities", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "grok-arguments");
    const originalBin = writeFakeGrok(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'grok 1.0.46'; exit 0 ;;
  *" --help "*) echo '--reasoning-effort <effort> --verbatim --rules <rules> --system-prompt-override <prompt> --tools <tools> --no-subagents --disable-web-search --no-plan'; exit 0 ;;
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
    for (const flag of ["--no-subagents", "--no-memory", "--disable-web-search", "--no-plan", "--tools", "--system-prompt-override"]) {
      expect(argumentsText).not.toContain(flag);
    }
    expect(argumentsText).toContain("--rules");
    expect(argumentsText).toContain(GROK_TOKEN_EFFICIENCY_INSTRUCTION);

    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "grok",
      mode: "balanced",
      optimizationApplied: true,
      optimizationProfile: "grok-balanced-v8"
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

  it("preserves explicit Grok feature flags when applying v7", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "grok-deduplicated-arguments.json");
    const originalBin = writeFakeGrok(paths, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("grok 1.0.46"); process.exit(0); }
if (args.includes("--help")) { console.log("--reasoning-effort <effort> --verbatim --rules <rules> --system-prompt-override <prompt> --tools <tools> --no-subagents --disable-web-search --no-plan"); process.exit(0); }
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
    for (const flag of ["--no-subagents", "--disable-web-search", "--no-memory"]) expect(observed.filter((argument) => argument === flag)).toHaveLength(1);
    cleanup(paths);
  });

  it("fails open before database creation when an explicit treatment value conflicts", async () => {
    const paths = temporaryPaths();
    const invocations = path.join(paths.userHome, "grok-conflict-invocations");
    const originalBin = writeFakeGrok(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'grok 1.0.46'; exit 0 ;;
  *" --help "*) echo '--reasoning-effort <effort> --verbatim --rules <rules> --system-prompt-override <prompt> --tools <tools>'; exit 0 ;;
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

  it("preserves Claude's original tools and browser flags with the v8 policy", async () => {
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
    config.defaultMode = "reduce";
    writeConfig(paths, config);

    expect(await withProviderPath(originalBin, () => runProvider("claude", ["-p", "private-task", "--tools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch", "--chrome"], paths))).toBe(0);
    const argumentsText = fs.readFileSync(observedArguments, "utf8");
    expect(argumentsText).toContain("low");
    expect(argumentsText).toContain("Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch");
    expect(argumentsText).toContain("--chrome");
    expect(argumentsText).not.toContain("--no-chrome");
    expect(argumentsText).not.toContain("--exclude-dynamic-system-prompt-sections");
    expect(argumentsText).toContain(CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION);

    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "claude",
      mode: "reduce",
      optimizationApplied: true,
      optimizationProfile: "claude-balanced-v8"
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
    expect(aggregate[0]).toMatchObject({ provider: "codex", reportedTotal: 7675, inputNew: null, output: null });
    database.close();
    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    const markdown = reportMarkdown(buildReport(paths, 7));
    for (const forbidden of ["response that must not persist", "super-secret-command-argument", "fake-codex"]) {
      expect(rawDatabase).not.toContain(forbidden);
      expect(markdown).not.toContain(forbidden);
    }
    cleanup(paths);
  });

  it("collects only verified usage from Codex exec JSONL mode", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "codex-json-arguments");
    const observedRun = path.join(paths.userHome, "codex-json-run");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'codex 0.155.1'; exit 0 ;;
  *" --help "*) echo '-c, --config <key=value> --json --model <model>'; exit 0 ;;
esac
printf '%s\\n' "$@" > '${observedArguments}'
printf '%s\\n' "$TP_RUN_CONTEXT_ID" > '${observedRun}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"private task result"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":15,"cache_write_input_tokens":3,"reasoning_output_tokens":10}}'
exit 0
`);
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);

    const args = ["exec", "--json", "--model", "gpt-6-luna", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "task"];
    expect(await withProviderPath(originalBin, () => runProvider("codex", args, paths))).toBe(0);
    const database = new TelemetryDatabase(paths);
    expect(database.recentRunsSince(new Date(0).toISOString())[0]).toMatchObject({
      provider: "codex",
      optimizationApplied: true,
      optimizationProfile: "codex-balanced-v18",
      collectionState: "collected"
    });
    const summary = database.sessionSummariesSince(new Date(0).toISOString())[0];
    const inheritedRun = fs.readFileSync(observedRun, "utf8").trim();
    expect(inheritedRun).toBe(summary.id);
    expect(reportSummaryMarkdown(buildReport(paths, 7), inheritedRun)).toContain("Cache reuse: 40%");
    expect(summary).toMatchObject({
      inputNew: 60,
      inputCached: 40,
      output: 15,
      reportedTotal: 115,
      reportedTotalIncludesCachedInput: true,
      categoryMetricsComplete: false,
      hasCacheCreated: 0,
      hasReasoning: 0
    });
    expect(database.aggregateSince(new Date(0).toISOString())[0]).toMatchObject({
      inputNew: 60,
      inputCached: 40,
      cacheCreated: null,
      output: 15,
      reasoning: null,
      reportedTotal: 115
    });
    database.close();

    const rawDatabase = fs.readFileSync(paths.databaseFile).toString("latin1");
    const markdown = reportMarkdown(buildReport(paths, 7));
    expect(rawDatabase).not.toContain("private task result");
    expect(markdown).not.toContain("private task result");
    const launchedArguments = fs.readFileSync(observedArguments, "utf8").trim().split("\n");
    expect(launchedArguments.slice(-args.length)).toEqual(args);
    expect(launchedArguments.join(" ")).toContain('model_reasoning_effort="low"');
    expect(launchedArguments.join(" ")).toContain(CODEX_V10_TOKEN_EFFICIENCY_INSTRUCTION);
    expect(launchedArguments.join(" ")).toContain("model_auto_compact_token_limit=16000");
    expect(launchedArguments.join(" ")).toContain("skills.max_context_tokens=2000");
    expect(launchedArguments.join(" ")).toContain('model_auto_compact_token_limit_scope="body_after_prefix"');
    for (const setting of ["model=", "model_reasoning_summary", "model_verbosity"]) {
      expect(launchedArguments.join(" ")).not.toContain(setting);
    }
    expect(rawDatabase).not.toContain(CODEX_V10_TOKEN_EFFICIENCY_INSTRUCTION);
    expect(markdown).not.toContain(CODEX_V10_TOKEN_EFFICIENCY_INSTRUCTION);
    cleanup(paths);
  });

  it.each(["--cd", "-C"])("budgets every enabled skill from the native catalog under the explicit Codex %s target", async (directoryFlag) => {
    const paths = temporaryPaths();
    const target = path.join(paths.userHome, "catalog-target");
    fs.mkdirSync(target, { recursive: true });
    const observedArguments = path.join(paths.userHome, "codex-catalog-arguments");
    const observedCatalogCwd = path.join(paths.userHome, "codex-catalog-cwd");
    const originalBin = writeFakeCodex(paths, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex 0.160.1"); process.exit(0); }
if (args[0] === "--help") { console.log("--config --model"); process.exit(0); }
fs.writeFileSync("${observedArguments}", args.join("\\n"));
process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n');
`, {
      skills: [
        { name: "n".repeat(5000), path: "/".repeat(3000), enabled: true },
        { name: "hidden", path: "/skills/hidden", enabled: false }
      ],
      observedCwdFile: observedCatalogCwd
    });
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);

    const args = ["exec", "--model", "gpt-6-astra", directoryFlag, target, "Task text containing literal --cd /wrong-directory"];
    expect(await withProviderPath(originalBin, () => runProvider("codex", args, paths))).toBe(0);
    const expectedBudget = Math.max(2_000,
      Math.ceil(Buffer.byteLength(`- ${"n".repeat(5000)}: (file: ${"/".repeat(3000)})\n`) / 4)
      + Math.ceil(Buffer.byteLength("- hidden: (file: /skills/hidden)\n") / 4)
      + 512);
    const launched = fs.readFileSync(observedArguments, "utf8");
    expect(launched).toContain(`skills.max_context_tokens=${expectedBudget}`);
    expect(JSON.parse(fs.readFileSync(observedCatalogCwd, "utf8"))).toEqual({ processCwd: fs.realpathSync(target), cwds: [target] });
    cleanup(paths);
  });

  it.each(["--profile", "--config"])("fails open when Codex %s may change the skill roster", async (override) => {
    const paths = temporaryPaths();
    const target = path.join(paths.userHome, "catalog-target");
    fs.mkdirSync(target, { recursive: true });
    const observedArguments = path.join(paths.userHome, "codex-override-arguments");
    const observedCatalogCwd = path.join(paths.userHome, "codex-override-catalog");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'codex 0.160.1'; exit 0 ;;
  *" --help "*) echo '--config --model'; exit 0 ;;
esac
printf '%s\\n' "$@" > '${observedArguments}'
exit 0
`, { observedCwdFile: observedCatalogCwd });
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);
    const args = ["exec", "--model", "gpt-6-astra", "--cd", target, override, override === "--profile" ? "personal" : "skills.catalog=custom", "Task"];

    expect(await withProviderPath(originalBin, () => runProvider("codex", args, paths))).toBe(0);
    const launched = fs.readFileSync(observedArguments, "utf8").trim().split("\n");
    expect(launched.slice(-args.length)).toEqual(args);
    expect(launched.join(" ")).not.toContain("skills.max_context_tokens=");
    expect(launched.join(" ")).not.toContain("developer_instructions=");
    expect(fs.existsSync(observedCatalogCwd)).toBe(false);
    cleanup(paths);
  });

  it("fails open without any Codex treatment when native skills metadata is uncertain", async () => {
    const paths = temporaryPaths();
    const observedArguments = path.join(paths.userHome, "codex-invalid-catalog-arguments");
    const observedCatalogCwd = path.join(paths.userHome, "codex-invalid-catalog-cwd");
    const originalBin = writeFakeCodex(paths, `#!/bin/sh
case " $* " in
  *" --version "*) echo 'codex 0.160.1'; exit 0 ;;
  *" --help "*) echo '--config --model'; exit 0 ;;
esac
printf '%s\\n' "$@" > '${observedArguments}'
exit 0
`, { errors: ["catalog unavailable"], observedCwdFile: observedCatalogCwd });
    const config = ensureConfig(paths);
    config.defaultMode = "reduce";
    writeConfig(paths, config);
    const args = ["exec", "--model", "gpt-6-astra", "Task"];

    expect(await withProviderPath(originalBin, () => runProvider("codex", args, paths))).toBe(0);
    const launched = fs.readFileSync(observedArguments, "utf8").trim().split("\n");
    expect(launched.slice(-args.length)).toEqual(args);
    expect(launched.join(" ")).not.toContain("skills.max_context_tokens=");
    expect(launched.join(" ")).not.toContain("developer_instructions=");
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
    expect(database.aggregateSince(new Date(Date.now() - 60_000).toISOString())[0]).toMatchObject({ provider: "claude", inputNew: null });
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
