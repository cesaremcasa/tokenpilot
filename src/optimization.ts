import { spawnSync } from "node:child_process";
import type { Provider, RunMode } from "./types.js";

/**
 * This fixed instruction is TokenPilot product code, not user or provider
 * content. Keeping it short and byte-stable makes its own cache cost bounded
 * while targeting repeated reads, verbose intermediate output, and unnecessary
 * tool turns. It is never stored in telemetry.
 */
export const TOKEN_EFFICIENCY_INSTRUCTION = "Minimize token use without reducing correctness. Inspect narrowly, batch independent reads, avoid rereading unchanged data or repeating context, keep intermediate explanations concise, and stop after the requested result is verified. Do not skip necessary validation or change requested scope.";

/**
 * Claude's latency policy is deliberately shorter than the cross-provider
 * instruction above. It tells Claude to batch independent work and perform a
 * single sufficient verification pass, while the CLI flags below remove
 * optional browser startup and keep dynamic machine data out of the reusable
 * system-prompt prefix. The text is fixed product code and is never persisted.
 */
export const CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION = "Finish correctly with minimal latency and tokens: inspect narrowly, batch independent reads, avoid rereading or narrating, verify once, and stop. Do not skip required validation or change scope.";

/**
 * Claude's default tool catalog is useful but expensive to send on every
 * request. Balanced v6 keeps the local coding primitives required to inspect,
 * search, create, and edit a repository while leaving the full native catalog
 * available through `deep` or the immediate bypass. The value is fixed product
 * code and is never derived from a project or stored in telemetry.
 */
export const CLAUDE_CORE_TOOLS = "Bash,Edit,Read,Write,Grep,Glob";

/**
 * Grok v2 still spent context loading unrelated skills, narrating tool use, and
 * reading broader source/test surfaces than the requested answer required.
 * Grok v3's generic "minimal" help value was rejected by the installed model;
 * v4 retains the empirically accepted "low" value while keeping the new rule.
 * This provider-specific rule is fixed and content-free. It preserves tools,
 * the native system prompt, safety checks, and the user's requested scope.
 */
export const GROK_TOKEN_EFFICIENCY_INSTRUCTION = "Preserve correctness while minimizing total context. Ignore skills unless the request directly invokes them. Search before reading; inspect only relevant ranges, batch related reads, never reread unchanged data, and avoid tests, docs, or live state unless needed. Do not narrate tool use or repeat context. Stop after the requested result is verified; never skip necessary validation or change scope.";

/** A plan never contains credentials or user-supplied command arguments. */
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
    if (!supports(help, "--effort") || !supports(help, "--tools") || !supports(help, "--append-system-prompt")) {
      return { ...NONE, unavailableReason: "this Claude CLI does not expose the complete token-reduction policy" };
    }
    // v7 keeps v6's proven core-tool bound, removes optional Chrome startup,
    // preserves a more reusable system-prompt prefix, and uses a shorter
    // latency-first instruction. Older compatible CLIs retain the measured v6
    // policy rather than receiving flags they did not advertise.
    if (supports(help, "--no-chrome") && supports(help, "--exclude-dynamic-system-prompt-sections")) {
      return {
        args: [
          "--effort", "low",
          "--tools", CLAUDE_CORE_TOOLS,
          "--no-chrome",
          "--exclude-dynamic-system-prompt-sections",
          "--append-system-prompt", CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION
        ],
        applied: true,
        profile: "claude-balanced-v7",
        summary: "low effort, core coding tools, no Chrome startup, stable cache prefix, one verification pass"
      };
    }
    return {
      args: [
        "--effort", "low",
        "--tools", CLAUDE_CORE_TOOLS,
        "--append-system-prompt", TOKEN_EFFICIENCY_INSTRUCTION
      ],
      applied: true,
      profile: "claude-balanced-v6",
      summary: "low effort, core coding tools, concise verified execution"
    };
  }

  if (provider === "codex") {
    if (!supports(help, "--config") && !supports(help, "-c,")) {
      return { ...NONE, unavailableReason: "this Codex CLI does not expose --config" };
    }
    return {
      args: [
        "--config", "model_reasoning_effort=\"low\"",
        "--config", "model_reasoning_summary=\"none\"",
        "--config", "model_verbosity=\"low\"",
        "--config", "model_auto_compact_token_limit=32000",
        "--config", "model_auto_compact_token_limit_scope=\"body_after_prefix\"",
        "--config", `developer_instructions=${JSON.stringify(TOKEN_EFFICIENCY_INSTRUCTION)}`
      ],
      applied: true,
      profile: "codex-balanced-v2",
      summary: "low reasoning, no reasoning summary, low verbosity, compact body at 32k tokens"
    };
  }

  if (provider === "grok") {
    const effortOption = supports(help, "--reasoning-effort") ? "--reasoning-effort" : supports(help, "--effort") ? "--effort" : undefined;
    return effortOption && supports(help, "--rules") && supports(help, "--verbatim")
      ? { args: [effortOption, "low", "--verbatim", "--rules", GROK_TOKEN_EFFICIENCY_INSTRUCTION], applied: true, profile: "grok-balanced-v4", summary: "low reasoning, verbatim prompt, targeted context without tool narration" }
      : { ...NONE, unavailableReason: "this Grok CLI does not expose the complete token-reduction policy" };
  }

  // Kimi remains fail-open until it offers a content-free, child-authenticated
  // session measurement interface. Advertised flags alone are insufficient.
  return { ...NONE, unavailableReason: "Kimi has no enabled safe measurement channel" };
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
    const plan = planFromHelp(provider, mode, result.stdout);
    if (!plan.applied) return plan;
    // Help advertises top-level flags, but Codex configuration keys and some
    // provider option combinations can still be rejected by the exact local
    // version. Probe the complete fixed plan without starting an AI session.
    const validation = spawnSync(binary, [...plan.args, "--help"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "ignore", "ignore"],
      env: environment
    });
    if (validation.error || validation.status !== 0) {
      return { ...NONE, unavailableReason: "this CLI rejected the complete token-reduction policy" };
    }
    return plan;
  } catch {
    return { ...NONE, unavailableReason: "could not verify this CLI version before applying a policy" };
  }
}
