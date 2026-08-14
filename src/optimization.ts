import { spawnSync } from "node:child_process";
import type { Provider, RunMode } from "./types.js";

/**
 * A plan contains only TokenPilot-owned policy names and provider CLI flags.
 * It deliberately never contains prompt text, a working directory, credentials,
 * or user-supplied command arguments.
 */
export interface OptimizationPlan {
  args: string[];
  applied: boolean;
  profile?: string;
  summary?: string;
  unavailableReason?: string;
}

const NONE: OptimizationPlan = { args: [], applied: false };

function supports(help: string, option: string): boolean {
  return help.includes(option);
}

/**
 * Convert a confirmed CLI capability set into a bounded, session-scoped policy.
 * Kept pure so every provider policy has a direct unit test.
 */
export function planFromHelp(provider: Provider, mode: RunMode, help: string): OptimizationPlan {
  if (mode !== "balanced") return NONE;

  if (provider === "claude") {
    const args: string[] = [];
    const labels: string[] = [];
    if (supports(help, "--exclude-dynamic-system-prompt-sections")) {
      args.push("--exclude-dynamic-system-prompt-sections");
      labels.push("stable cache prefix");
    }
    if (supports(help, "--effort")) {
      args.push("--effort", "medium");
      labels.push("medium reasoning");
    }
    // Do not override tools. A tool allowlist can change developer capability
    // and itself changes the system prompt; Claude's native tool selection is
    // the safer cache-stable default for an invisible launcher.
    return args.length > 0
      ? { args, applied: true, profile: "claude-balanced-v2", summary: labels.join(", ") }
      : { ...NONE, unavailableReason: "this Claude CLI does not expose the validated balanced flags" };
  }

  if (provider === "codex") {
    if (!supports(help, "--config") && !supports(help, "-c,")) {
      return { ...NONE, unavailableReason: "this Codex CLI does not expose --config" };
    }
    return {
      args: [
        "--config", "model_reasoning_effort=\"medium\"",
        "--config", "model_verbosity=\"low\"",
        "--config", "model_auto_compact_token_limit=64000"
      ],
      applied: true,
      profile: "codex-balanced-v1",
      summary: "medium reasoning, low verbosity, compact at 64k tokens"
    };
  }

  if (provider === "grok") {
    const effortOption = supports(help, "--reasoning-effort") ? "--reasoning-effort" : supports(help, "--effort") ? "--effort" : undefined;
    return effortOption
      ? { args: [effortOption, "medium"], applied: true, profile: "grok-balanced-v1", summary: "medium reasoning" }
      : { ...NONE, unavailableReason: "this Grok CLI does not expose a reasoning-effort flag" };
  }

  // Kimi 0.29.x does not advertise these session-scoped controls. Do not edit
  // its persistent config or assume API prompt-cache settings work in the CLI.
  if (supports(help, "--no-thinking") && supports(help, "--max-steps-per-turn") && supports(help, "--max-retries-per-step")) {
    return {
      args: ["--no-thinking", "--max-steps-per-turn", "20", "--max-retries-per-step", "2"],
      applied: true,
      profile: "kimi-balanced-v1",
      summary: "thinking off, 20 steps per turn, two retries per step"
    };
  }
  return { ...NONE, unavailableReason: "this Kimi CLI version lacks validated session-scoped optimization flags" };
}

/**
 * Probe only the installed provider binary. If the probe fails, do not mutate
 * the invocation: the wrapper remains fail-open and telemetry still works.
 */
export function planForInstalledCli(
  provider: Provider,
  mode: RunMode,
  binary: string,
  environment: NodeJS.ProcessEnv = process.env,
  verifyBinary: (candidate: string) => boolean = () => true
): OptimizationPlan {
  if (mode !== "balanced") return NONE;
  try {
    if (!verifyBinary(binary)) return { ...NONE, unavailableReason: "could not verify this CLI executable before applying a policy" };
    const result = spawnSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: environment
    });
    if (result.error || result.status !== 0) {
      return { ...NONE, unavailableReason: "could not verify this CLI version before applying a policy" };
    }
    return planFromHelp(provider, mode, result.stdout);
  } catch {
    return { ...NONE, unavailableReason: "could not verify this CLI version before applying a policy" };
  }
}
