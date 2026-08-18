import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CORE_TOOLS, CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION, GROK_HEADLESS_TOOLS, GROK_TOKEN_EFFICIENCY_INSTRUCTION, mergeTreatmentArguments, planForInstalledCli, planFromHelp, TOKEN_EFFICIENCY_INSTRUCTION } from "../src/optimization.js";

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

  it("uses session-only Codex overrides and does not enable prompt telemetry", () => {
    const plan = planFromHelp("codex", "balanced", "-c, --config <key=value> --profile <profile>");
    expect(plan).toMatchObject({ applied: true, profile: "codex-balanced-v2" });
    expect(plan.args.join(" ")).toContain("model_reasoning_effort");
    expect(plan.args.join(" ")).toContain("model_reasoning_effort=\"low\"");
    expect(plan.args.join(" ")).toContain("model_reasoning_summary=\"none\"");
    expect(plan.args.join(" ")).toContain("model_auto_compact_token_limit=32000");
    expect(plan.args.join(" ")).toContain("model_auto_compact_token_limit_scope=\"body_after_prefix\"");
    expect(plan.args.join(" ")).toContain("developer_instructions=");
    expect(plan.args.join(" ")).not.toContain("otel.log_user_prompt");
  });

  it("uses only documented Grok CLI controls rather than API cache headers", () => {
    const help = "--reasoning-effort <effort> --verbatim --no-subagents --no-memory --disable-web-search --no-plan --system-prompt-override <prompt> --tools <tools>";
    expect(planFromHelp("grok", "balanced", help)).toMatchObject({
      profile: "grok-balanced-v6",
      args: [
        "--reasoning-effort", "low",
        "--verbatim",
        "--no-subagents",
        "--no-memory",
        "--disable-web-search",
        "--no-plan",
        "--system-prompt-override", GROK_TOKEN_EFFICIENCY_INSTRUCTION
      ],
      headlessArgs: ["--tools", GROK_HEADLESS_TOOLS]
    });
  });

  it("leaves Grok unchanged when any complete v6 control is unavailable", () => {
    const required = ["--reasoning-effort", "--verbatim", "--no-subagents", "--no-memory", "--disable-web-search", "--no-plan", "--system-prompt-override", "--tools"];
    for (const missing of required) {
      const help = required.filter((flag) => flag !== missing).join(" ");
      expect(planFromHelp("grok", "balanced", help)).toMatchObject({
        applied: false,
        args: [],
        unavailableReason: expect.stringContaining("complete token-reduction policy")
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
    const help = "--reasoning-effort <effort> --verbatim --no-subagents --no-memory --disable-web-search --no-plan --system-prompt-override <prompt> --tools <tools>";
    expect(planFromHelp("grok", "reduce", help)).toEqual(planFromHelp("grok", "balanced", help));
    expect(planFromHelp("grok", "reduce", help).applied).toBe(true);
  });

  it("deduplicates the exact Grok reproduction while preserving explicit argument order", () => {
    const help = "--reasoning-effort <effort> --verbatim --no-subagents --no-memory --disable-web-search --no-plan --system-prompt-override <prompt> --tools <tools>";
    const plan = planFromHelp("grok", "reduce", help);
    const explicit = ["--single", "Return exactly TOKENPILOT_CANARY_OK.", "--max-turns", "1", "--no-subagents", "--disable-web-search", "--no-memory", "--output-format", "json"];
    const merged = mergeTreatmentArguments("grok", explicit, [...plan.args, ...(plan.headlessArgs ?? [])]);
    expect(merged).toMatchObject({ applied: true, deduplicated: true, conflicts: [] });
    const mergedArgs = merged.args;
    expect(mergedArgs.slice(-explicit.length)).toEqual(explicit);
    for (const flag of ["--no-subagents", "--disable-web-search", "--no-memory"]) {
      expect(mergedArgs.filter((argument) => argument === flag)).toHaveLength(1);
    }
    expect(mergedArgs).toContain("--tools");
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
      expect(planForInstalledCli("codex", "balanced", binary, { PATH: "/usr/bin:/bin" })).toMatchObject({
        applied: false,
        args: [],
        unavailableReason: expect.stringContaining("rejected the complete")
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
