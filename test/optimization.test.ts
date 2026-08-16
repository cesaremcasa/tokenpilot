import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CORE_TOOLS, CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION, GROK_TOKEN_EFFICIENCY_INSTRUCTION, planForInstalledCli, planFromHelp, TOKEN_EFFICIENCY_INSTRUCTION } from "../src/optimization.js";

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
    expect(planFromHelp("grok", "balanced", "--reasoning-effort <effort> --rules <rules> --verbatim")).toMatchObject({
      profile: "grok-balanced-v4",
      args: ["--reasoning-effort", "low", "--verbatim", "--rules", GROK_TOKEN_EFFICIENCY_INSTRUCTION]
    });
  });

  it("leaves Grok unchanged when verbatim prompting is unavailable", () => {
    expect(planFromHelp("grok", "balanced", "--reasoning-effort <effort> --rules <rules>")).toMatchObject({
      applied: false,
      args: [],
      unavailableReason: expect.stringContaining("complete token-reduction policy")
    });
  });

  it("leaves an older Kimi CLI untouched instead of guessing unsupported flags", () => {
    const plan = planFromHelp("kimi", "balanced", "Usage: kimi [--model MODEL] [PROMPT]");
    expect(plan).toMatchObject({ applied: false });
    expect(plan.args).toEqual([]);
    expect(plan.unavailableReason).toContain("audited local session protocol");
  });

  it("never enables Kimi from generic flags without the audited versioned bridge", () => {
    const plan = planFromHelp("kimi", "balanced", "--no-thinking --max-steps-per-turn N --max-retries-per-step N");
    expect(plan).toMatchObject({ applied: false, unavailableReason: expect.stringContaining("audited local session protocol") });
    expect(plan.args).toEqual([]);
  });

  it("does not alter deep or observe sessions", () => {
    expect(planFromHelp("codex", "observe", "--config")).toMatchObject({ applied: false, args: [] });
    expect(planFromHelp("codex", "deep", "--config")).toMatchObject({ applied: false, args: [] });
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
