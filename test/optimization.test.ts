import { describe, expect, it } from "vitest";
import { planFromHelp } from "../src/optimization.js";

describe("version-gated balanced optimization", () => {
  it("applies only the validated Claude controls advertised by the installed CLI", () => {
    const plan = planFromHelp("claude", "balanced", "--exclude-dynamic-system-prompt-sections --effort <level> --tools <tools>");
    expect(plan).toMatchObject({ applied: true, profile: "claude-balanced-v1" });
    expect(plan.args).toEqual([
      "--exclude-dynamic-system-prompt-sections",
      "--effort", "medium",
      "--tools", "Read,Edit,Glob,Grep,Bash"
    ]);
  });

  it("uses session-only Codex overrides and does not enable prompt telemetry", () => {
    const plan = planFromHelp("codex", "balanced", "-c, --config <key=value> --profile <profile>");
    expect(plan).toMatchObject({ applied: true, profile: "codex-balanced-v1" });
    expect(plan.args.join(" ")).toContain("model_reasoning_effort");
    expect(plan.args.join(" ")).toContain("model_auto_compact_token_limit=64000");
    expect(plan.args.join(" ")).not.toContain("otel.log_user_prompt");
  });

  it("uses the documented Grok CLI effort flag rather than API cache headers", () => {
    expect(planFromHelp("grok", "balanced", "--reasoning-effort <effort>").args).toEqual(["--reasoning-effort", "medium"]);
  });

  it("leaves an older Kimi CLI untouched instead of guessing unsupported flags", () => {
    const plan = planFromHelp("kimi", "balanced", "Usage: kimi [--model MODEL] [PROMPT]");
    expect(plan).toMatchObject({ applied: false });
    expect(plan.args).toEqual([]);
    expect(plan.unavailableReason).toContain("lacks validated");
  });

  it("activates the Kimi policy only when all required session controls exist", () => {
    const plan = planFromHelp("kimi", "balanced", "--no-thinking --max-steps-per-turn N --max-retries-per-step N");
    expect(plan).toMatchObject({ applied: true, profile: "kimi-balanced-v1" });
    expect(plan.args).toEqual(["--no-thinking", "--max-steps-per-turn", "20", "--max-retries-per-step", "2"]);
  });

  it("does not alter deep or observe sessions", () => {
    expect(planFromHelp("codex", "observe", "--config")).toMatchObject({ applied: false, args: [] });
    expect(planFromHelp("codex", "deep", "--config")).toMatchObject({ applied: false, args: [] });
  });
});
