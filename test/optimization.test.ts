import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planForInstalledCli, planFromHelp, TOKEN_EFFICIENCY_INSTRUCTION } from "../src/optimization.js";

describe("version-gated balanced optimization", () => {
  it("keeps Claude observe-only after tested controls produced cache-shift", () => {
    const plan = planFromHelp("claude", "balanced", "--effort <level> --append-system-prompt <prompt> --tools <tools>");
    expect(plan).toMatchObject({ applied: false, args: [], unavailableReason: expect.stringContaining("cache-shift") });
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

  it("uses the documented Grok CLI effort flag rather than API cache headers", () => {
    expect(planFromHelp("grok", "balanced", "--reasoning-effort <effort> --rules <rules>")).toMatchObject({ profile: "grok-balanced-v2", args: ["--reasoning-effort", "low", "--rules", TOKEN_EFFICIENCY_INSTRUCTION] });
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
