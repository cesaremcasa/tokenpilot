import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CORE_TOOLS, CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION, CODEX_TOKEN_EFFICIENCY_INSTRUCTION, CODEX_V6_TOKEN_EFFICIENCY_INSTRUCTION, GROK_TOKEN_EFFICIENCY_INSTRUCTION, codexModelFromArgs, mergeTreatmentArguments, planForInstalledCli, planFromHelp, TOKEN_EFFICIENCY_INSTRUCTION } from "../src/optimization.js";

describe("version-gated balanced optimization", () => {
  it("uses the latency-first Claude v7 policy when every flag is advertised", () => {
    const plan = planFromHelp("claude", "balanced", "--effort <level> --append-system-prompt <prompt> --tools <tools> --no-chrome --exclude-dynamic-system-prompt-sections");
    expect(plan).toMatchObject({
      applied: true,
      profile: "claude-balanced-v7",
      args: [
        "--effort", "low",
        "--tools", CLAUDE_CORE_TOOLS,
        "--no-chrome",
        "--exclude-dynamic-system-prompt-sections",
        "--append-system-prompt", CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION
      ]
    });
  });

  it("retains the measured Claude v6 policy on older compatible CLIs", () => {
    expect(planFromHelp("claude", "balanced", "--effort <level> --append-system-prompt <prompt> --tools <tools>")).toMatchObject({
      applied: true,
      profile: "claude-balanced-v6",
      args: ["--effort", "low", "--tools", CLAUDE_CORE_TOOLS, "--append-system-prompt", TOKEN_EFFICIENCY_INSTRUCTION]
    });
  });

  it("leaves Claude unchanged when the complete v6 policy is unavailable", () => {
    expect(planFromHelp("claude", "balanced", "--effort <level> --tools <tools>")).toMatchObject({
      applied: false,
      args: [],
      unavailableReason: expect.stringContaining("complete token-reduction policy")
    });
  });

  it("routes only an unambiguous explicit Codex model without reading prompt or config values", () => {
    for (const args of [
      ["exec", "--model", "gpt-5.5"],
      ["exec", "--model=gpt-5.5"],
      ["exec", "-m", "gpt-5.5"],
      ["exec", "-m=gpt-5.5"],
      ["--model", "gpt-5.5", "exec", "--sandbox", "workspace-write"],
      ["exec", "--sandbox", "workspace-write", "--model", "gpt-5.5"],
      ["exec", "--enable", "feature", "--model", "gpt-5.5"],
      ["--model", "gpt-5.5", "exec", "task --model gpt-6-luna"]
    ]) {
      expect(codexModelFromArgs(args)).toBe("gpt-5.5");
    }
    for (const args of [
      ["exec", "--config", "model=\"gpt-5.5\""],
      ["exec", "--config", "model_provider=custom", "--model", "gpt-5.5"],
      ["exec", "--model", "gpt-5.5", "--config", "model_providers.openai.wire_api=chat"],
      ["exec", "--profile", "fast"],
      ["exec", "--oss", "--model", "gpt-5.5"],
      ["exec", "--local-provider", "ollama", "--model", "gpt-5.5"],
      ["exec", "--config", "developer_instructions=\"Use --model gpt-5.5\""],
      ["exec", "--", "--model", "gpt-5.5"],
      ["exec", "--provider-extension", "--model", "gpt-5.5"],
      ["exec", "--model", "gpt-5.5", "--model", "gpt-6-luna"],
      ["exec", "task --model gpt-5.5"],
      ["exec", "exec", "--model", "gpt-5.5"],
      ["exec", "--model", "gpt-6-luna", "task", "--model", "gpt-5.5"],
      ["--config", "key=value", "exec", "--model", "gpt-5.5"]
    ]) {
      expect(codexModelFromArgs(args)).toBeUndefined();
    }
    expect(codexModelFromArgs(["exec", "--model", "gpt-6-luna"])).toBe("gpt-6-luna");
    expect(codexModelFromArgs(["--model", "gpt-5.5", "exec", "task"])).toBe("gpt-5.5");
    expect(codexModelFromArgs(["exec", "--config", 'model="gpt-6-luna"', "--model", "gpt-5.5"])).toBe("gpt-5.5");
    expect(codexModelFromArgs(["exec", "--model", "gpt-5.5", "--config", 'model="gpt-6-luna"'])).toBe("gpt-5.5");
  });

  it("scopes Codex v4 to explicitly selected gpt-5.5 and retains v3 for other explicit models", () => {
    const help = "-c, --config <key=value> --profile <profile>";
    const plan = planFromHelp("codex", "balanced", help, "gpt-5.5");
    expect(plan).toMatchObject({ applied: true, profile: "codex-balanced-v4" });
    expect(plan.args.join(" ")).toContain("model_reasoning_effort=\"low\"");
    expect(plan.args.join(" ")).toContain("model_reasoning_summary=\"none\"");
    expect(plan.args.join(" ")).toContain(CODEX_TOKEN_EFFICIENCY_INSTRUCTION);
    expect(plan.args.join(" ")).not.toContain("model_auto_compact_token_limit");
    expect(CODEX_TOKEN_EFFICIENCY_INSTRUCTION).not.toContain("at most three");
    expect(CODEX_TOKEN_EFFICIENCY_INSTRUCTION).not.toContain("nl -ba");

    const priorPolicy = planFromHelp("codex", "balanced", help, "gpt-6-astra");
    expect(priorPolicy).toMatchObject({ applied: true, profile: "codex-balanced-v3" });
    expect(priorPolicy.args.join(" ")).toContain("model_auto_compact_token_limit=32000");
    expect(priorPolicy.args.join(" ")).toContain("model_auto_compact_token_limit_scope=\"body_after_prefix\"");
    for (const forbidden of ["agents.enabled=false", "memories.use_memories=false", "tools.web_search=false", "features.apps=false", "otel.log_user_prompt"]) {
      expect(plan.args.join(" ")).not.toContain(forbidden);
      expect(priorPolicy.args.join(" ")).not.toContain(forbidden);
    }
    expect(planFromHelp("codex", "balanced", help)).toMatchObject({ applied: false, args: [] });
  });

  it("uses native model controls with concise batched workflow guidance for gpt-6-luna and daybreak", () => {
    const help = "-c, --config <key=value> --profile <profile>";
    for (const model of ["gpt-6-luna", "gpt-daybreak-blue-latest"]) {
      const plan = planFromHelp("codex", "balanced", help, model);
      expect(plan).toMatchObject({ applied: true, profile: "codex-balanced-v6" });
      expect(plan.args).toEqual(["--config", `developer_instructions=${JSON.stringify(CODEX_V6_TOKEN_EFFICIENCY_INSTRUCTION)}`]);
      for (const setting of ["model=", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "model_auto_compact_token_limit"]) {
        expect(plan.args.join(" ")).not.toContain(setting);
      }
      expect(CODEX_V6_TOKEN_EFFICIENCY_INSTRUCTION).toContain("batch independent searches and reads");
      expect(CODEX_V6_TOKEN_EFFICIENCY_INSTRUCTION).toContain("Run all requested checks");
      expect(CODEX_V6_TOKEN_EFFICIENCY_INSTRUCTION).not.toContain("at most");
      for (const capability of ["agents.enabled=false", "memories.use_memories=false", "tools.web_search=false", "features.apps=false"]) {
        expect(plan.args.join(" ")).not.toContain(capability);
      }
    }
  });

  it("uses current Grok controls while preserving the full feature surface", () => {
    const help = "--reasoning-effort <effort> --verbatim --rules <rules> --tools <tools> --no-subagents --disable-web-search --no-plan";
    const plan = planFromHelp("grok", "balanced", help);
    expect(plan).toMatchObject({
      applied: true,
      profile: "grok-balanced-v7",
      args: [
        "--reasoning-effort", "low",
        "--verbatim",
        "--rules", GROK_TOKEN_EFFICIENCY_INSTRUCTION
      ]
    });
    for (const disabledCapability of ["--no-subagents", "--no-memory", "--disable-web-search", "--no-plan", "--tools"]) {
      expect(plan.args).not.toContain(disabledCapability);
    }
    expect(plan.headlessArgs).toBeUndefined();
  });

  it("leaves Grok unchanged when a required v7 control is unavailable", () => {
    const required = ["--reasoning-effort", "--verbatim", "--rules"];
    for (const missing of required) {
      const help = required.filter((flag) => flag !== missing).join(" ");
      expect(planFromHelp("grok", "balanced", help)).toMatchObject({
        applied: false,
        args: [],
        unavailableReason: expect.stringContaining("complete capability-preserving token-reduction policy")
      });
    }
  });

  it("leaves an older Kimi CLI untouched instead of guessing unsupported flags", () => {
    const plan = planFromHelp("kimi", "balanced", "Usage: kimi [--model MODEL] [PROMPT]");
    expect(plan).toMatchObject({ applied: false });
    expect(plan.args).toEqual([]);
    expect(plan.unavailableReason).toContain("no enabled safe measurement channel");
  });

  it("never enables Kimi from generic flags without a safe measurement channel", () => {
    const plan = planFromHelp("kimi", "balanced", "--no-thinking --max-steps-per-turn N --max-retries-per-step N");
    expect(plan).toMatchObject({ applied: false, unavailableReason: expect.stringContaining("no enabled safe measurement channel") });
    expect(plan.args).toEqual([]);
  });

  it("does not alter deep or observe sessions", () => {
    expect(planFromHelp("codex", "observe", "--config")).toMatchObject({ applied: false, args: [] });
    expect(planFromHelp("codex", "deep", "--config")).toMatchObject({ applied: false, args: [] });
  });

  it("applies the same Grok treatment in reduce mode as in balanced mode", () => {
    const help = "--reasoning-effort <effort> --verbatim --rules <rules> --tools <tools>";
    expect(planFromHelp("grok", "reduce", help)).toEqual(planFromHelp("grok", "balanced", help));
    expect(planFromHelp("grok", "reduce", help).applied).toBe(true);
  });

  it("preserves explicit Grok feature choices under the complete-surface policy", () => {
    const help = "--reasoning-effort <effort> --verbatim --rules <rules> --tools <tools>";
    const plan = planFromHelp("grok", "reduce", help);
    const explicit = ["--single", "Return exactly TOKENPILOT_CANARY_OK.", "--max-turns", "1", "--no-subagents", "--disable-web-search", "--no-memory", "--output-format", "json"];
    const merged = mergeTreatmentArguments("grok", explicit, [...plan.args, ...(plan.headlessArgs ?? [])]);
    expect(merged).toMatchObject({ applied: true, deduplicated: false, conflicts: [] });
    const mergedArgs = merged.args;
    expect(mergedArgs.slice(-explicit.length)).toEqual(explicit);
    for (const flag of ["--no-subagents", "--disable-web-search", "--no-memory"]) {
      expect(mergedArgs.filter((argument) => argument === flag)).toHaveLength(1);
    }
    expect(mergedArgs).not.toContain("--tools");
  });

  it("lets explicit value flags win across aliases and --flag=value forms", () => {
    const merged = mergeTreatmentArguments("codex",
      ["--config=developer_instructions=--no-memory", "-c", "model_verbosity=high", "task --no-subagents"],
      ["--reasoning-effort", "low", "--config", "developer_instructions=low", "--config", "model_verbosity=low", "--no-memory"]
    );
    expect(merged).toMatchObject({ applied: false, conflicts: ["config:developer_instructions", "config:model_verbosity"] });
    expect(merged.args).toEqual(["--config=developer_instructions=--no-memory", "-c", "model_verbosity=high", "task --no-subagents"]);
    expect(mergeTreatmentArguments("grok", ["--effort=high"], ["--reasoning-effort", "low"])).toMatchObject({ applied: false, conflicts: ["effort"] });
  });

  it("fails open for conflicting Claude value overrides", () => {
    const plan = planFromHelp("claude", "balanced", "--effort <level> --tools <tools> --append-system-prompt <prompt> --no-chrome --exclude-dynamic-system-prompt-sections");
    const explicit = ["--tools=Read", "--append-system-prompt", "--no-chrome", "task"];
    const merged = mergeTreatmentArguments("claude", explicit, plan.args);
    expect(merged.applied).toBe(false);
    expect(merged.args).toEqual(explicit);
    expect(merged).toMatchObject({ conflicts: ["tools", "append-system-prompt"] });
  });

  it("does not mistake a prompt value that resembles a flag for an explicit boolean", () => {
    const merged = mergeTreatmentArguments("grok",
      ["--single", "--no-subagents", "prompt --disable-web-search"],
      ["--no-subagents", "--disable-web-search"]
    );
    expect(merged.args).toEqual(["--no-subagents", "--disable-web-search", "--single", "--no-subagents", "prompt --disable-web-search"]);
  });

  it("fails closed to the launcher when an explicit value-taking flag is incomplete", () => {
    expect(mergeTreatmentArguments("codex", ["--config"], ["--config", "model_verbosity=low"])).toMatchObject({ applied: false, conflicts: ["--config"], reason: "ambiguous explicit treatment argument" });
  });

  it("fails open when unknown options may consume a treatment flag as their value", () => {
    for (const option of ["--agent", "--agents", "--allow", "--deny"]) {
      expect(mergeTreatmentArguments("grok", [option, "--no-subagents"], ["--no-subagents"])).toMatchObject({ applied: false });
    }
    expect(mergeTreatmentArguments("claude", ["--provider-extension", "--no-chrome"], ["--no-chrome"])).toMatchObject({ applied: false });
    expect(mergeTreatmentArguments("codex", ["--provider-extension", "--config"], ["--config", "model_verbosity=low"])).toMatchObject({ applied: false });
  });

  it("keeps Codex treatment active when a valueless option precedes a known option value", () => {
    const injected = ["--config", "model_verbosity=low"];
    const sandboxFirst = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", "/tmp/repo", "--output-last-message", "/tmp/last.txt", "prompt"];
    const skipFirst = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", "/tmp/repo", "--output-last-message", "/tmp/last.txt", "prompt"];

    expect(mergeTreatmentArguments("codex", sandboxFirst, injected).applied).toBe(true);
    expect(mergeTreatmentArguments("codex", skipFirst, injected).applied).toBe(true);
  });

  it("keeps known booleans and post-delimiter positional values unambiguous", () => {
    expect(mergeTreatmentArguments("grok", ["--no-memory", "--no-subagents"], ["--no-memory", "--no-subagents"])).toMatchObject({ applied: true, deduplicated: true });
    const delimited = mergeTreatmentArguments("grok", ["--", "--no-subagents"], ["--no-subagents"]);
    expect(delimited).toMatchObject({ applied: true, conflicts: [] });
    expect(delimited.args).toEqual(["--no-subagents", "--", "--no-subagents"]);
  });

  it("fails open when the exact CLI rejects the complete fixed policy", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-policy-"));
    const binary = path.join(directory, "codex");
    fs.writeFileSync(binary, "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo '--config'; exit 0; fi\nexit 64\n", { mode: 0o700 });
    try {
      expect(planForInstalledCli("codex", "balanced", binary, { PATH: "/usr/bin:/bin" }, undefined, "gpt-5.5")).toMatchObject({
        applied: false,
        args: [],
        unavailableReason: expect.stringContaining("rejected the complete")
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
